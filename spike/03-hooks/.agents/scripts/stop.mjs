#!/usr/bin/env node
import { main } from './lib.mjs';

// No-op: let the agent stop normally.
await main('Stop', async () => ({}));
