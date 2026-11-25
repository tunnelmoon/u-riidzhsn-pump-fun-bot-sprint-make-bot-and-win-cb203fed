// hello: the bot answers one batch of orders per slot.
// Pump.fun Bot Sprint entry: a launch-confirmation bot (see strategy.ts). Run by the grader as
// `node /bot/main.ts`; the protocol lives in the vendored SDK shim (vendor/makefun-bot.ts, a
// byte-identical copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
