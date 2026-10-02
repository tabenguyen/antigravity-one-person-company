#!/usr/bin/env node
import { readStdin, logEntry } from './lib.mjs';

const raw = await readStdin();
let payload = null;
try { payload = JSON.parse(raw); } catch {}
logEntry('PreToolUse-nonzero', process.env.HOOK_RUN_TAG || 'unspecified-run', {
  ts: new Date().toISOString(),
  note: 'about to exit 1 with no stdout',
  payload,
});
process.exitCode = 1;
