// The structured result the company researcher must return (--json-schema) and the validation we apply to it.
//
// The JSON Schema is hand-written (no zod-to-json-schema dependency) and deliberately light on constraints: agy's
// structured-output tool is picky with exotic keywords, so the real rules live in validateGenerated(), whose error
// list is fed back to the model verbatim in the single repair turn.

import { z } from "zod";
import type { GeneratedSetup } from "../admin-types.ts";
import { CompanyProfileInputZ } from "../admin-types.ts";
import { findPlaceholder, placeholderMarkers } from "../readiness/placeholders.ts";

export const REQUIRED_ROLE_KB_FILES = ["icp.md", "sales-playbook.md", "objection-handling.md"] as const;
const MIN_KB_BODY_CHARS = 200;
const FIELD_FOR_FILE: Record<string, string> = { "icp.md": "icp", "sales-playbook.md": "salesPlaybook", "objection-handling.md": "objectionHandling" };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;

export const GENERATED_SETUP_JSON_SCHEMA = {
  type: "object",
  description: "The company profile, sales knowledge base and sources researched from the company's website.",
  properties: {
    profile: {
      type: "object",
      properties: {
        companyName: { ...str, description: "Brand/legal name as the company itself writes it" },
        website: { ...nullableStr, description: "Canonical https URL of the domain the user gave" },
        oneLiner: { ...str, description: "10-300 chars: what the company sells and to whom" },
        productDescription: str,
        targetCustomers: str,
        painPoints: { ...str, description: "One string; use markdown bullets separated by newlines" },
        differentiators: { ...str, description: "One string (markdown bullets separated by newlines); empty string if the pages state none" },
        pricingPolicy: { ...str, description: "Exact listed prices (with VAT note if stated) and what an agent may/may not say about price" },
        proofPoints: { ...str, description: "Only facts the pages state; empty string if none" },
        forbiddenClaims: { ...str, description: "One string, one claim per line: claims the agent must never make, including unverifiable marketing claims found on the site" },
        meetingLink: { ...nullableStr, description: "Booking URL if the site has one, else null" },
        languages: { type: "array", items: str, description: 'Language codes, e.g. ["vi","en"]' },
      },
      required: [
        "companyName",
        "website",
        "oneLiner",
        "productDescription",
        "targetCustomers",
        "painPoints",
        "differentiators",
        "pricingPolicy",
        "proofPoints",
        "forbiddenClaims",
        "meetingLink",
        "languages",
      ],
    },
    roleKb: {
      type: "object",
      description: "Three markdown documents for the AI SDR (each a single string with newlines, starting with an H1, no placeholders)",
      properties: {
        icp: { ...str, description: "Markdown for icp.md: ideal customer profile" },
        salesPlaybook: { ...str, description: "Markdown for sales-playbook.md" },
        objectionHandling: { ...str, description: "Markdown for objection-handling.md" },
      },
      required: ["icp", "salesPlaybook", "objectionHandling"],
    },
    suggestedSender: {
      type: "object",
      properties: {
        name: nullableStr,
        address: { ...nullableStr, description: "A contact/sales email stated on the site; never guess one" },
        companyAddressLine: { ...nullableStr, description: "Legal name + postal address as stated on the site" },
        unsubscribeMailto: { ...nullableStr, description: "Only if the site states a suitable mailbox; usually null" },
      },
      required: ["name", "address", "companyAddressLine", "unsubscribeMailto"],
    },
    sources: {
      type: "array",
      description: "Every page you actually read",
      items: { type: "object", properties: { url: str, title: nullableStr }, required: ["url", "title"] },
    },
    conflicts: { type: "array", items: str, description: "Each item ONE plain string: a contradiction between pages (e.g. two different price lists), naming both URLs" },
    openQuestions: { type: "array", items: str, description: "Each item ONE plain string: a fact the site does not state that a human must fill in" },
  },
  required: ["profile", "roleKb", "suggestedSender", "sources", "conflicts", "openQuestions"],
} as const;

const nullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  });

/** A list entry the model wrote as a string — or, as models do, as {detail|text|description: "..."}. */
function entryText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["detail", "text", "description", "summary", "question", "conflict", "message"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    return Object.values(o).filter((x) => typeof x === "string").join(" — ");
  }
  return v == null ? "" : String(v);
}

const textList = z
  .array(z.unknown())
  .default([])
  .transform((a) => a.map(entryText).map((t) => t.trim()).filter(Boolean));

type RoleKbFileRaw = { relPath: string; title: string; body: string };

/** Accepts {icp, salesPlaybook, objectionHandling}, {files:[{relPath,body}]} or {files:{"icp.md": "..."}}. */
function normalizeRoleKb(raw: unknown): RoleKbFileRaw[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const out: RoleKbFileRaw[] = [];
  const flat: [string, string][] = [
    ["icp", "icp.md"],
    ["salesPlaybook", "sales-playbook.md"],
    ["objectionHandling", "objection-handling.md"],
  ];
  for (const [key, rel] of flat) {
    if (typeof o[key] === "string") out.push({ relPath: rel, title: "", body: o[key] as string });
  }
  const files = o["files"];
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f && typeof f === "object") {
        const r = f as Record<string, unknown>;
        out.push({ relPath: String(r["relPath"] ?? ""), title: typeof r["title"] === "string" ? r["title"] : "", body: typeof r["body"] === "string" ? r["body"] : "" });
      }
    }
  } else if (files && typeof files === "object") {
    for (const [name, body] of Object.entries(files as Record<string, unknown>)) {
      out.push({ relPath: name.replace(/^["'\s]+|["'\s]+$/g, ""), title: "", body: typeof body === "string" ? body : "" });
    }
  }
  return out;
}

const RawGeneratedZ = z.object({
  profile: z.record(z.unknown()),
  roleKb: z.unknown().transform(normalizeRoleKb),
  suggestedSender: z
    .object({ name: nullableText, address: nullableText, companyAddressLine: nullableText, unsubscribeMailto: nullableText })
    .default({ name: null, address: null, companyAddressLine: null, unsubscribeMailto: null }),
  sources: z.array(z.object({ url: z.string(), title: nullableText })),
  conflicts: textList,
  openQuestions: textList,
});

function trimProfile(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== "languages" && Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v.map((x) => `- ${String(x).trim()}`).join("\n"); // a list where text was expected -> markdown bullets
    } else {
      out[k] = typeof v === "string" ? v.trim() : v;
    }
  }
  for (const key of ["website", "meetingLink"]) if (out[key] === "" || out[key] === undefined) out[key] = null;
  if (Array.isArray(out["languages"]) && out["languages"].length === 0) delete out["languages"];
  return out;
}

export type ValidationResult = { ok: true; setup: GeneratedSetup; warnings: string[] } | { ok: false; errors: string[] };

/** Everything the human would otherwise discover later: schema, placeholders, KB completeness, sane sources. */
export function validateGenerated(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const shape = RawGeneratedZ.safeParse(raw);
  if (!shape.success) {
    return { ok: false, errors: shape.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const data = shape.data;

  const trimmedProfile = trimProfile(data.profile);
  const profileParsed = CompanyProfileInputZ.safeParse(trimmedProfile);
  let profile: GeneratedSetup["profile"] | null = null;
  if (!profileParsed.success) {
    for (const i of profileParsed.error.issues) errors.push(`profile.${i.path.join(".") || "(root)"}: ${i.message}`);
  } else {
    profile = profileParsed.data;
  }
  // Placeholder scan runs even when the schema check failed, so one repair turn can fix everything at once.
  for (const [field, value] of Object.entries(trimmedProfile)) {
    if (typeof value !== "string") continue;
    const markers = placeholderMarkers(value);
    if (markers.length > 0) errors.push(`profile.${field}: contains placeholder text (${markers.join(", ")}); write real content`);
  }

  const seen = new Set<string>();
  for (const [i, f] of data.roleKb.entries()) {
    const label = `roleKb.${FIELD_FOR_FILE[f.relPath] ?? `files[${i}]`} (${f.relPath || "no name"})`;
    if (!/^[\w-]+\.md$/.test(f.relPath)) errors.push(`${label}: relPath must look like "icp.md" (letters, digits, - and _ only)`);
    if (seen.has(f.relPath)) errors.push(`${label}: duplicate relPath`);
    seen.add(f.relPath);
    if (f.body.trim().length < MIN_KB_BODY_CHARS) errors.push(`${label}: body is too short (${f.body.trim().length} chars); write the full document`);
    const hit = findPlaceholder(f.body);
    if (hit) errors.push(`${label}: placeholder text on line ${hit.line} (${hit.marker}): "${hit.text}"`);
  }
  for (const required of REQUIRED_ROLE_KB_FILES) {
    if (!seen.has(required)) errors.push(`roleKb.${FIELD_FOR_FILE[required]}: missing required file ${required}; write it as one markdown string`);
  }

  const sources: GeneratedSetup["sources"] = [];
  for (const s of data.sources) {
    try {
      const u = new URL(s.url);
      if (u.protocol === "http:" || u.protocol === "https:") sources.push({ url: u.toString(), title: s.title });
      else errors.push(`sources: "${s.url}" is not an http(s) URL`);
    } catch {
      errors.push(`sources: "${s.url}" is not a valid URL`);
    }
  }
  if (sources.length === 0 && data.sources.length === 0) errors.push("sources: list every page you read (at least the home page)");

  const sender = { ...data.suggestedSender };
  for (const key of ["address", "unsubscribeMailto"] as const) {
    const v = sender[key];
    if (v && !EMAIL_RE.test(v.replace(/^mailto:/i, ""))) {
      warnings.push(`suggestedSender.${key} "${v}" is not a valid email address; dropped`);
      sender[key] = null;
    } else if (v) {
      sender[key] = v.replace(/^mailto:/i, "");
    }
  }

  if (errors.length > 0 || !profile) return { ok: false, errors };
  const setup: GeneratedSetup = {
    profile: profile as GeneratedSetup["profile"],
    roleKb: {
      role: "sales-sdr",
      files: data.roleKb.map((f) => ({ relPath: f.relPath, title: f.title.trim() || f.relPath.replace(/\.md$/, ""), body: f.body.trim() + "\n" })),
    },
    suggestedSender: sender,
    sources,
    conflicts: data.conflicts,
    openQuestions: data.openQuestions,
  };
  return { ok: true, setup, warnings };
}
