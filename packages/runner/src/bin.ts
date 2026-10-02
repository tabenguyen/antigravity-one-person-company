// Shared "which agy binary" resolution used by the runner, version probe,
// and quota reader. See docs/PHASE0.md D2: default to PATH lookup ("agy"),
// but allow an explicit override (AGY_BIN env var, or a per-call option) so
// tests can point at a fake binary without touching PATH.

export function resolveAgyBin(agyBin?: string): string {
  return agyBin ?? process.env.AGY_BIN ?? "agy";
}
