// Minimal YAML-frontmatter parser/serializer for agy customization files
// (.agents/agents/*.md, .agents/rules/*.md, .agents/skills/*/SKILL.md).
//
// agy's own frontmatter is a small, known subset of YAML (verified in
// spike/02-workspace-agents: plain scalars, folded block scalars `>-`, and
// simple string lists). We don't pull in a YAML dependency for this — we
// fully control what we write, and only need to read back what this same
// module (or the spike examples) produces.

export type FrontmatterValue = string | string[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedFrontmatter {
  data: FrontmatterData;
  body: string;
}

const FENCE = "---";

/** Parse a `---\n<yaml>\n---\n<body>` document. Throws if no frontmatter fence is found. */
export function parseFrontmatter(content: string, sourceLabel: string): ParsedFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    throw new Error(`${sourceLabel}: expected frontmatter starting with "---"`);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error(`${sourceLabel}: unterminated frontmatter (no closing "---")`);
  }
  const yamlLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  const data = parseYamlBlock(yamlLines, sourceLabel);
  return { data, body };
}

function parseYamlBlock(lines: string[], sourceLabel: string): FrontmatterData {
  const data: FrontmatterData = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`${sourceLabel}: could not parse frontmatter line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const key = m[1]!;
    const rest = (m[2] ?? "").trim();
    i++;

    if (rest === ">-" || rest === ">" || rest === "|-" || rest === "|") {
      const folded = rest.startsWith(">");
      const block: string[] = [];
      while (i < lines.length && (lines[i] === "" || /^[ \t]/.test(lines[i] ?? ""))) {
        if (lines[i] === "") {
          block.push("");
          i++;
          continue;
        }
        block.push((lines[i] ?? "").replace(/^ {1,4}/, ""));
        i++;
      }
      data[key] = folded ? foldLines(block) : block.join("\n").replace(/\n+$/, "");
      continue;
    }

    if (rest === "") {
      // Either a list or an empty scalar.
      const items: string[] = [];
      while (i < lines.length && /^[ \t]*-[ \t]/.test(lines[i] ?? "")) {
        const itemLine = (lines[i] ?? "").replace(/^[ \t]*-[ \t]/, "").trim();
        items.push(unquote(itemLine));
        i++;
      }
      data[key] = items;
      continue;
    }

    data[key] = unquote(rest);
  }
  return data;
}

function foldLines(block: string[]): string {
  // YAML folded scalar: blank lines become a single newline (paragraph break),
  // consecutive non-blank lines join with a space.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const l of block) {
    if (l === "") {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(l);
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

const WRAP_COL = 88;

/** Serialize frontmatter data (in the given key order) + body back into a `---` document. */
export function stringifyFrontmatter(data: FrontmatterData, body: string): string {
  const lines: string[] = [FENCE];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
      continue;
    }
    const oneLine = `${key}: ${JSON.stringify(value)}`;
    if (oneLine.length <= WRAP_COL && !value.includes("\n")) {
      lines.push(oneLine);
    } else {
      lines.push(`${key}: >-`);
      for (const wrapped of wrapText(value, WRAP_COL - 2)) lines.push(`  ${wrapped}`);
    }
  }
  lines.push(FENCE);
  const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "");
  return `${lines.join("\n")}\n\n${trimmedBody}\n`;
}

function wrapText(text: string, width: number): string[] {
  const paragraphs = text.split(/\n+/);
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length) out.push(line);
  }
  return out.length ? out : [""];
}
