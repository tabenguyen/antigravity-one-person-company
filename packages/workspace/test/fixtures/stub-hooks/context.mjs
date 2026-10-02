#!/usr/bin/env node
// No-op PreInvocation stub for tests (injects nothing). Real context injection lives in @agyhq/hooks.
import { readStdinJson } from "./read-stdin.mjs";
await readStdinJson();
process.stdout.write(JSON.stringify({}));
