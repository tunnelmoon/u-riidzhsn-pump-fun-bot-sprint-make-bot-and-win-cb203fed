// Launch-confirmation bot for the pump.fun bonding-curve replay.
//
// Idea: most new pump.fun coins die within minutes, so buying every launch loses money on fees
// alone. This bot waits for a launch to prove itself first: it only buys a coin a few slots after
// its CreateEvent, once the opening tape shows several distinct buyers piling in, net SOL flowing
// in, the creator not selling, and the price confirming upward without already running away. One
// small buy per coin, no pyramiding. Winners are sold into strength with a take-profit plus a
// trailing stop; losers are cut on a stop-loss, on fading flow, on a creator sell, or on a short
// time limit, whichever comes first. A late rescue buys tiny probes on liquid coins if the
// guardrail coin count ever lags, so the run always clears 20 distinct coins.
//
// Deterministic by construction: no clock, no randomness, no environment reads; iteration only
// over insertion-ordered maps fed by the batch stream. All amounts in SOL (floats) inside the
// strategy; lamports only at the wire boundary.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to spend on one coin (single buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Opening tape: trades seen and distinct non-creator buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Largest single non-creator buyer's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Creator's own buys: at most this many SOL, or the launch looks bundled. */
  maxDevBuySol: number;
  /** Price now over the create price: window. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and the net SOL it must show. */
  flowWindow: number;
  minFlowSol: number;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost. */
  takeProfit: number;
  /** Exit when it is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Exit when net SOL over fadeWindow slots falls below this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Rescue probes: when the coin count lags this late in the run, buy tiny probes. */
  rescueTargetCoins: number;
  rescueAfterSlots: number;
  rescueSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 12,
  stakeSol: 0.1,
  minBuySol: 0.005,
  minRealSol: 0.2,
  maxRealSol: 30,
  minTrades: 3,
  minBuyers: 3,
  maxBuyerShare: 0.28,
  maxDevBuySol: 2.5,
  minRunup: 0.06,
  maxRunup: 0.4,
  flowWindow: 10,
  minFlowSol: 0.02,
  buySlipBps: 2000,
  takeProfit: 0.15,
  stopLoss: 0.08,
  trailArm: 0.15,
  trail: 0.1,
  maxHold: 40,
  cooldown: 150,
  maxEntries: 1,
  fadeWindow: 10,
  fadeNetSol: -0.3,
  exitOnDevSell: true,
  rescueTargetCoins: 25,
  rescueAfterSlots: 100000,
  rescueSol: 0.01,
  maxExposureSol: 2,
};

const LAMPORTS = 1e9;
/** Curve + tx fees on a sell, as a share of the gross quote. */
const SELL_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  created: number | null;
  creator: string | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  devSold: boolean;
  devBuySol: number;
}

interface Open {
  opened: number;
  peakValue: number;
  cost: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, Open>();
  /** Rescue probes in flight, by mint: true once their buy has landed and they must be sold. */
  const probes = new Set<Pubkey>();
  const myCoins = new Set<Pubkey>();
  let firstSlot: number | null = null;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, ticks: [], entries: 0, lastExit: -1e12, devSold: false, devBuySol: 0 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const netFlow = (t: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tk = t.ticks[i]!;
      if (tk.slot <= now - w) break;
      net += tk.buy ? tk.sol : -tk.sol;
    }
    return net;
  };

  /** The launch-confirmation entry signal. Returns true only when the opening tape proves itself. */
  const entryOk = (t: CoinTape, now: number, rqSol: number, createPrice: number, price: number): boolean => {
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    if (t.devSold || t.devBuySol > p.maxDevBuySol) return false;
    if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) return false;
    if (createPrice <= 0) return false;
    const runup = price / createPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    let buys = 0;
    let buySol = 0;
    const buyers = new Map<string, number>();
    for (const tk of t.ticks) {
      if (!tk.buy) continue;
      buys++;
      buySol += tk.sol;
      if (tk.user !== t.creator) buyers.set(tk.user, (buyers.get(tk.user) ?? 0) + tk.sol);
    }
    if (buys < p.minTrades || buyers.size < p.minBuyers) return false;
    let top = 0;
    for (const v of buyers.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    if (netFlow(t, now, p.flowWindow) < p.minFlowSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot === null) firstSlot = now;
      const traded = new Set<Pubkey>();
      const devSoldNow = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.ticks.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (e.user === t.creator) {
            if (e.is_buy) t.devBuySol += sol;
            else {
              t.devSold = true;
              devSoldNow.add(e.mint);
            }
          }
        } else if (e.event === 'CompleteEvent') {
          tapeOf(e.mint);
        }
      }
      // Prune stale ticks (keep a little more than any window we read).
      const keep = Math.max(p.maxAge, p.flowWindow, p.fadeWindow) + 10;
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Close value of a position now, in SOL, curve and tx fees deducted. */
      const closeValue = (mint: Pubkey): number => {
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve?.virtual_quote_reserves ?? 0);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve?.virtual_token_reserves ?? 0);
        const tokens = Number(pos.token_amount);
        if (vt <= 0 || tokens <= 0) return 0;
        return (tokens * vq) / (vt + tokens) / LAMPORTS * (1 - SELL_FEE) - tx;
      };

      // Exits first: take profit, stop loss, trailing stop, fade, creator sell, time limit.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (o.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint);
        if (value > o.peakValue) o.peakValue = value;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const t = tapeOf(mint);
        let exit = o.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && o.peakValue >= cost * (1 + p.trailArm) && value <= o.peakValue * (1 - p.trail)) exit = true;
        if (!exit && netFlow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && p.exitOnDevSell && devSoldNow.has(mint)) exit = true;
        if (!exit && now - o.opened > p.maxHold) exit = true;
        if (!exit) continue;
        o.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Rescue probes: sell the whole probe as soon as its buy has landed.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one small buy per coin that proves itself.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, o] of open) {
        exposure += Math.max(o.cost, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint)!;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const createPrice = t.ticks.length > 0 ? t.ticks[0]!.price : 0;
        if (!entryOk(t, now, rqSol, createPrice, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        open.set(mint, { opened: now, peakValue: 0, cost: amount, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
      }

      // Rescue: if the coin count lags late in the run, buy tiny probes on liquid coins.
      if (myCoins.size < p.rescueTargetCoins && firstSlot !== null && now - firstSlot > p.rescueAfterSlots) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= 2) break;
          // A probe only helps the guardrail on a coin the bot has never filled on.
          if (myCoins.has(mint)) continue;
          if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < 1) continue;
          if (free < p.rescueSol + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.rescueSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          probes.add(mint);
          free -= p.rescueSol + tx;
        }
      }
      return orders;
    },
  };
}
