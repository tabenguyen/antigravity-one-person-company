// Shared helper for all hook scripts in this spike.
// No external deps (Node builtins only), per spike instructions.
import fs from 'node:fs';
import path from 'node:path';

const RAW_DIR = '/Users/nguyentam/Documents/Makini/agy-ui/spike/03-hooks/raw';

export async function readStdin() {
  return await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

// logName: logical event/test name used for the log filename, e.g. "PreToolUse"
// runTag: optional subdir/prefix to separate experiment runs, e.g. "01-baseline"
export function logEntry(logName, runTag, entry) {
  const dir = runTag ? path.join(RAW_DIR, runTag) : RAW_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${logName}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function dumpEnv(logName, runTag) {
  const dir = runTag ? path.join(RAW_DIR, runTag) : RAW_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${logName}.env.json`);
  fs.writeFileSync(file, JSON.stringify(process.env, null, 2));
}

export async function main(eventName, handler) {
  const runTag = process.env.HOOK_RUN_TAG || 'unspecified-run';
  const raw = await readStdin();
  let payload = null;
  let parseError = null;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    parseError = String(e);
  }
  const entry = {
    ts: new Date().toISOString(),
    event: eventName,
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    pid: process.pid,
    raw,
    payload,
    parseError,
  };
  logEntry(eventName, runTag, entry);
  if (process.env.HOOK_DUMP_ENV === '1') {
    dumpEnv(eventName, runTag);
  }
  const response = await handler(payload, entry);
  process.stdout.write(JSON.stringify(response ?? {}));
}
