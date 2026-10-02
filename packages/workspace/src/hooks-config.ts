// Builds .agents/hooks.json — the EXACT contract shared with @agyhq/hooks
// (that package builds the scripts these commands point at). See docs/PHASE0.md
// D5 and spike/03-hooks/FINDINGS.md for the hooks.json file shape agy expects:
// a top-level map of hook-bundle name -> { PreToolUse/PostToolUse: matcher
// groups, PreInvocation/PostInvocation/Stop: flat handler lists }.

import path from "node:path";

export interface HooksConfigVars {
  /** Absolute path to the node binary to run hook scripts with. */
  nodeBin: string;
  /** Absolute path to the built @agyhq/hooks scripts directory. */
  hooksDistDir: string;
}

/** The single hook-bundle name agy-hq registers under in hooks.json. */
export const HOOKS_BUNDLE_NAME = "agyhq";

function shQuote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

function scriptCommand(nodeBin: string, hooksDistDir: string, file: string, extraArg?: string): string {
  const scriptPath = path.join(hooksDistDir, file);
  const parts = [shQuote(nodeBin), shQuote(scriptPath)];
  if (extraArg) parts.push(extraArg);
  return parts.join(" ");
}

export interface HooksConfig {
  [bundleName: string]: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; timeout: number }> }>;
    PostToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; timeout: number }> }>;
    PreInvocation: Array<{ type: "command"; command: string; timeout: number }>;
    PostInvocation: Array<{ type: "command"; command: string; timeout: number }>;
    Stop: Array<{ type: "command"; command: string; timeout: number }>;
  };
}

export function buildHooksConfig({ nodeBin, hooksDistDir }: HooksConfigVars): HooksConfig {
  return {
    [HOOKS_BUNDLE_NAME]: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: scriptCommand(nodeBin, hooksDistDir, "pre-tool-use.mjs"), timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              command: scriptCommand(nodeBin, hooksDistDir, "audit.mjs", "PostToolUse"),
              timeout: 5,
            },
          ],
        },
      ],
      PreInvocation: [{ type: "command", command: scriptCommand(nodeBin, hooksDistDir, "context.mjs"), timeout: 10 }],
      PostInvocation: [
        { type: "command", command: scriptCommand(nodeBin, hooksDistDir, "audit.mjs", "PostInvocation"), timeout: 5 },
      ],
      Stop: [{ type: "command", command: scriptCommand(nodeBin, hooksDistDir, "stop.mjs"), timeout: 10 }],
    },
  };
}
