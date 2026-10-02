#!/usr/bin/env node
import { main } from './lib.mjs';

// Policy gate: deny any run_command whose CommandLine matches a deny pattern,
// otherwise allow. Used to test whether PreToolUse can hard-block a tool call,
// and whether it still runs/works under --dangerously-skip-permissions.
const DENY_PATTERN = /\brm\s+-rf\b|\bcurl\b|\bwget\b/i;

await main('PreToolUse', async (payload) => {
  const tc = payload?.toolCall;
  if (tc?.name === 'run_command') {
    const cmd = tc.args?.CommandLine || '';
    if (DENY_PATTERN.test(cmd)) {
      return {
        decision: 'deny',
        reason: `agy-hq policy gate: command "${cmd}" matches a denied pattern (rm -rf / curl / wget).`,
      };
    }
  }
  return { decision: 'allow' };
});
