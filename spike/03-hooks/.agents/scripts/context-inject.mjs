#!/usr/bin/env node
import { main } from './lib.mjs';

// Context injection test: only inject on the FIRST invocation of a turn so we
// don't spam every loop iteration. The injected fact ("prefers Vietnamese")
// is not present anywhere in the user prompt — only a correct answer proves
// the model actually saw this injected context.
await main('PreInvocation', async (payload) => {
  return {
    injectSteps: [
      {
        ephemeralMessage:
          'Customer note (from CRM, not from the user): this customer prefers to be addressed in Vietnamese.',
      },
    ],
  };
});
