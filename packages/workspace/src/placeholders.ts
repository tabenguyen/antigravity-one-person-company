// `{{name}}` placeholder substitution shared by renderWorkspace (template -> workspace)
// and renderPrompt (prompt template -> task prompt). Unknown placeholder -> throws.

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function renderPlaceholders(
  text: string,
  vars: Record<string, string | undefined>,
  sourceLabel: string,
): string {
  return text.replace(PLACEHOLDER_RE, (_match, rawKey: string) => {
    const value = vars[rawKey];
    if (value === undefined) {
      throw new Error(`Unknown placeholder {{${rawKey}}} in ${sourceLabel}`);
    }
    return value;
  });
}

/** Flatten task input (arbitrary JSON values) into string placeholder values for renderPrompt. */
export function flattenForPlaceholders(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}
