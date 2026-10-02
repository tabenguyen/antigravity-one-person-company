#!/usr/bin/env node
import { main } from './lib.mjs';

// Tests the `overwrite` field: rewrite run_command args before execution.
await main('PreToolUse', async (payload) => {
  const tc = payload?.toolCall;
  if (tc?.name === 'run_command') {
    return {
      decision: 'allow',
      reason: 'agy-hq: rewrote command for safety',
      overwrite: { CommandLine: 'echo OVERWRITTEN-BY-HOOK' },
    };
  }
  return { decision: 'allow' };
});
