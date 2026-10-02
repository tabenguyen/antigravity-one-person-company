import fs from "node:fs";
import path from "node:path";
import { TemplateJsonZ, type Template } from "./types.ts";

/** Load and validate templates/<role>/template.json (+ required sibling files). Throws on any problem. */
export function loadTemplate(templatesRoot: string, role: string): Template {
  const templateDir = path.join(templatesRoot, role);
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    throw new Error(`Template directory not found for role "${role}": ${templateDir}`);
  }

  const jsonPath = path.join(templateDir, "template.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`template.json not found for role "${role}" at ${jsonPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (err) {
    throw new Error(`template.json for role "${role}" is not valid JSON: ${(err as Error).message}`);
  }
  const parseResult = TemplateJsonZ.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(`template.json for role "${role}" failed validation: ${parseResult.error.message}`);
  }
  const parsed = parseResult.data;
  if (parsed.role !== role) {
    throw new Error(`template.json "role" ("${parsed.role}") does not match template directory name "${role}"`);
  }

  for (const required of ["AGENTS.md", "agent.md"]) {
    const p = path.join(templateDir, required);
    if (!fs.existsSync(p)) {
      throw new Error(`${required} not found for role "${role}" at ${p}`);
    }
  }

  const resultSchemaPath = path.join(templateDir, parsed.resultSchema);
  if (!fs.existsSync(resultSchemaPath)) {
    throw new Error(`resultSchema file not found for role "${role}": ${resultSchemaPath}`);
  }
  let resultSchema: unknown;
  try {
    resultSchema = JSON.parse(fs.readFileSync(resultSchemaPath, "utf8"));
  } catch (err) {
    throw new Error(`resultSchema at ${resultSchemaPath} is not valid JSON: ${(err as Error).message}`);
  }

  for (const tk of parsed.taskKinds) {
    const promptPath = path.join(templateDir, tk.prompt);
    if (!fs.existsSync(promptPath)) {
      throw new Error(`Prompt file for task kind "${tk.kind}" (role "${role}") not found: ${promptPath}`);
    }
  }

  const rulesDir = path.join(templateDir, "rules");
  const skillsDir = path.join(templateDir, "skills");
  const kbDir = path.join(templateDir, "kb");

  return {
    role: parsed.role,
    description: parsed.description,
    defaultModel: parsed.defaultModel,
    policy: parsed.policy,
    taskKinds: parsed.taskKinds,
    templateDir,
    resultSchemaPath,
    resultSchema,
    hasRules: fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory(),
    hasSkills: fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory(),
    hasKb: fs.existsSync(kbDir) && fs.statSync(kbDir).isDirectory(),
  };
}

/** List role directories under templatesRoot that contain a template.json (for discovery/tests). */
export function listTemplateRoles(templatesRoot: string): string[] {
  if (!fs.existsSync(templatesRoot)) return [];
  return fs
    .readdirSync(templatesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(templatesRoot, e.name, "template.json")))
    .map((e) => e.name)
    .sort();
}
