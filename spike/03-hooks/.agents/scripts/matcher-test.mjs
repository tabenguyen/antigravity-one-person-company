#!/usr/bin/env node
import { main } from './lib.mjs';

// Logs every PreToolUse call this hook receives, so we can see which tool
// names actually trigger it given a matcher regex in hooks.json.
await main('PreToolUse', async (payload) => ({ decision: 'allow' }));
