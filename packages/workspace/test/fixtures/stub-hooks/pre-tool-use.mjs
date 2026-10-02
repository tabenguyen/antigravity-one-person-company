#!/usr/bin/env node
// Trivial allow-everything PreToolUse stub for tests. Real policy gate lives in @agyhq/hooks.
import { readStdinJson } from "./read-stdin.mjs";
await readStdinJson();
process.stdout.write(JSON.stringify({ decision: "allow" }));
