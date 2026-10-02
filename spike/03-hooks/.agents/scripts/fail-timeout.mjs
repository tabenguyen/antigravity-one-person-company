#!/usr/bin/env node
import { readStdin, logEntry } from './lib.mjs';

// Deliberately hangs past the hook's configured timeout (hooks.json sets
// timeout: 3 for this one) to test the fail-open/fail-closed behavior on
// hook timeout.
const raw = await readStdin();
let payload = null;
try { payload = JSON.parse(raw); } catch {}
logEntry('PreToolUse-timeout', process.env.HOOK_RUN_TAG || 'unspecified-run', {
  ts: new Date().toISOString(),
  note: 'about to sleep past timeout',
  payload,
});
await new Promise((r) => setTimeout(r, 15000));
process.stdout.write(JSON.stringify({ decision: 'allow' }));
