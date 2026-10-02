#!/usr/bin/env node
import { readStdin, logEntry } from './lib.mjs';

const raw = await readStdin();
let payload = null;
try { payload = JSON.parse(raw); } catch {}
logEntry('PreToolUse-invalid-json', process.env.HOOK_RUN_TAG || 'unspecified-run', {
  ts: new Date().toISOString(),
  note: 'about to print invalid JSON to stdout',
  payload,
});
process.stdout.write('this is not { json');
