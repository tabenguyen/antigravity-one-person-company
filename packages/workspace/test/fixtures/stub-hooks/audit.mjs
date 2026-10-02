#!/usr/bin/env node
// No-op audit stub for tests (PostToolUse/PostInvocation). Real audit sink lives in @agyhq/hooks.
import { readStdinJson } from "./read-stdin.mjs";
await readStdinJson();
process.stdout.write(JSON.stringify({}));
