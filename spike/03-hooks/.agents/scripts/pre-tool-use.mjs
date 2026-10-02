#!/usr/bin/env node
import { main } from './lib.mjs';

// No-op audit hook: allow everything, just log the payload.
await main('PreToolUse', async () => ({ decision: 'allow' }));
