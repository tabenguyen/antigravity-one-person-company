#!/usr/bin/env node
import { main } from './lib.mjs';

// Tests forcing an "ask" decision from PreToolUse even when the CLI is run
// with --dangerously-skip-permissions.
await main('PreToolUse', async (payload) => {
  const tc = payload?.toolCall;
  if (tc?.name === 'run_command') {
    return { decision: 'force_ask', reason: 'agy-hq: always confirm shell commands' };
  }
  return { decision: 'allow' };
});
