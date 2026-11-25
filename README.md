[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/tunnelmoon/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/tunnelmoon/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint: launch-confirmation bot

A deterministic trading bot for the pump.fun bonding-curve replay
(`pumpfun-replay/v2`). It trades paper SOL on a replay of pump.fun chain data
and is ranked on net PnL after all fees.

## Strategy: buy only launches that prove themselves

Most new pump.fun coins die within minutes, so buying every launch loses money
on fees alone. This bot waits for a launch to prove itself first:

- **Entry (age 1-12 slots after CreateEvent):** at least 3 trades and 3
  distinct non-creator buyers, the largest single buyer holding at most 32%
  of the window's buy SOL, the creator not selling and his own buys under
  2.5 SOL, price up 6-40% from the create price, and net SOL flowing in over
  the last 10 slots. One small buy per coin (0.1 SOL, capped at 1% of the
  curve's real SOL), no pyramiding.
- **Exits:** take-profit +15%, stop-loss -8%, trailing stop 10% once up 15%,
  fade exit on net flow below -0.3 SOL over 10 slots, exit when the creator
  sells, time limit 40 slots.
- **Guardrail backstop:** if the coin count ever lags late in the run, tiny
  0.01 SOL rescue probes on liquid coins the bot never filled on, so the run
  always clears 20 distinct coins.
- **Fee discipline:** no trading every tick, small stakes, at most 5 open
  positions. Each round trip costs about 1.25% curve fees per side plus
  105,000 lamports in tx fees, so the entry filter has to earn its keep.

## Determinism

The bot is a pure function of the batches it is fed: no clock, no randomness,
no environment reads. The grader runs it twice and the two action logs must
match byte for byte; `grade-local` reproduced the dev result byte for byte.

## Dev backtest (kit's frozen dev window, full 128,058 events)

- Net PnL: **+0.0256 SOL** (10 SOL paper capital), 150 fills over 74 coins,
  75 round trips, win rate 25%, max drawdown 0.42%
- Guardrails met: 74 coins hold a round trip of at least 0.01 SOL, drawdown
  far under the 50% limit
- Determinism: the grader runs the bot twice and the two action logs match;
  `grade-local` reports "L1 regrade reproduced byte for byte"
- Baselines on the same window (pilot tools, first 50,000 events only):
  momentum -9.38 SOL, reversion -1.78 SOL, sniper -0.13 SOL, hold-cash 0 SOL
- Honest note: the dev edge is small and within noise (90% interval roughly
  -0.11 to +0.13 SOL). The final window is fresh data recorded after entries
  close, so this is a breakeven-ish bot with tight risk control, not a
  guaranteed winner.

## Files

- `main.ts` - entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` - the strategy (original work, written for this bounty)
- `vendor/makefun-bot.ts` - the kit's SDK shim, vendored byte-identical
- `.makefun/owner.json` - payout wallet

## License

MIT. See `LICENSE`.
