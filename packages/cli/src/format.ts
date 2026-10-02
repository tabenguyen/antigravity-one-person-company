// Minimal human-readable table/kv printer. No table library is a listed
// dependency, so this is intentionally simple: fixed-width columns, no
// wrapping/truncation beyond a sane max.

export function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]!);
  const cells = rows.map((r) => cols.map((c) => stringify(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));

  const printRow = (values: string[]) => {
    console.log(values.map((v, i) => v.padEnd(widths[i]!)).join("  "));
  };
  printRow(cols);
  printRow(widths.map((w) => "-".repeat(w)));
  for (const row of cells) printRow(row);
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printKv(obj: Record<string, unknown>): void {
  const keys = Object.keys(obj);
  const width = Math.max(...keys.map((k) => k.length));
  for (const k of keys) {
    console.log(`${k.padEnd(width)}  ${stringify(obj[k])}`);
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
