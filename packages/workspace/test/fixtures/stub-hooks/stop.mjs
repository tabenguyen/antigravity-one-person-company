#!/usr/bin/env node
// No-op Stop stub for tests (always lets the agent stop). Real checkpoint logic lives in @agyhq/hooks.
import { readStdinJson } from "./read-stdin.mjs";
await readStdinJson();
process.stdout.write(JSON.stringify({}));
