#!/usr/bin/env node
import { main } from './lib.mjs';

// Force the agent to keep going for the first 2 Stop events (executionNum 0,1),
// then let it actually stop on the 3rd (executionNum >= 2). Verifies whether
// a Stop hook can block termination and whether the injected reason reaches
// the model as a system message that changes its next action.
await main('Stop', async (payload) => {
  const n = payload?.executionNum ?? 0;
  if (n < 2) {
    return {
      decision: 'continue',
      reason: `agy-hq checkpoint: not done yet (forced continuation #${n + 1}). Please say the word CHECKPOINT${n + 1} and then try to stop again.`,
    };
  }
  return {};
});
