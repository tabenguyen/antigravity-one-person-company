import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../util.ts";
import { EvalCaseZ, SuiteConfigZ, type EvalCase, type LoadedSuite } from "./types.ts";

/** Suites are role templates that ship an evals/ directory. */
export function listSuites(templatesRoot: string): string[] {
  if (!fs.existsSync(templatesRoot)) return [];
  return fs
    .readdirSync(templatesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(templatesRoot, e.name, "evals")))
    .map((e) => e.name)
    .sort();
}

/** Load + validate `templates/<suite>/evals`. Throws ValidationError with file-specific messages. */
export function loadSuite(templatesRoot: string, suite: string): LoadedSuite {
  if (!/^[a-z0-9-]+$/.test(suite)) throw new ValidationError(`invalid suite name "${suite}"`);
  const dir = path.join(templatesRoot, suite, "evals");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new ValidationError(`eval suite "${suite}" not found (expected ${dir}); available: ${listSuites(templatesRoot).join(", ") || "none"}`);
  }

  let rawConfig: unknown = {};
  const configPath = path.join(dir, "suite.json");
  if (fs.existsSync(configPath)) rawConfig = readJson(configPath);
  const cfg = SuiteConfigZ.safeParse(rawConfig);
  if (!cfg.success) throw new ValidationError(`${configPath}: ${cfg.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "suite.json").sort()) {
    const raw = readJson(path.join(dir, file));
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const parsed = EvalCaseZ.safeParse(item);
      if (!parsed.success) {
        throw new ValidationError(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(case)"}: ${i.message}`).join("; ")}`);
      }
      if (seen.has(parsed.data.id)) throw new ValidationError(`${file}: duplicate case id "${parsed.data.id}"`);
      seen.add(parsed.data.id);
      cases.push(parsed.data);
    }
  }
  if (cases.length === 0) throw new ValidationError(`eval suite "${suite}" has no cases in ${dir}`);

  const kbDir = path.join(dir, "kb");
  const kbFiles = fs.existsSync(kbDir)
    ? fs
        .readdirSync(kbDir)
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .sort()
        .map((f) => path.join(kbDir, f))
    : [];

  return { name: suite, dir, config: cfg.data, cases, kbFiles };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ValidationError(`${file}: not valid JSON (${(err as Error).message})`);
  }
}
