// Eval case + assertion schemas. A suite is `templates/<role>/evals/*.json` (each file
// holds one case or an array of cases) plus optional `evals/suite.json` and `evals/kb/*.md`.

import { z } from "zod";
import { LEAD_STAGES } from "../routines/config.ts";

const StageZ = z.enum(LEAD_STAGES);

/** Matches draft text: exactly one of value / anyOf / pattern. Matching is case-insensitive. */
const TextMatcherShape = {
  value: z.string().min(1).optional(),
  anyOf: z.array(z.string().min(1)).min(1).optional(),
  /** JavaScript regular expression source, case-insensitive. */
  pattern: z.string().min(1).optional(),
};
const oneMatcher = (v: { value?: string; anyOf?: string[]; pattern?: string }) =>
  [v.value, v.anyOf, v.pattern].filter((x) => x !== undefined).length === 1;
const MATCHER_MSG = "provide exactly one of value, anyOf, pattern";

const ResultStatusZ = z.object({
  type: z.literal("result.status"),
  equals: z.string().optional(),
  oneOf: z.array(z.string()).min(1).optional(),
});

const ResultDataZ = z.object({
  type: z.literal("result.data.path"),
  /** Dot path into task.result.data, e.g. "classification" or "fit". */
  path: z.string().min(1),
  equals: z.unknown().optional(),
  oneOf: z.array(z.unknown()).min(1).optional(),
  exists: z.boolean().optional(),
});

const CountZ = z.object({
  equals: z.number().int().min(0).optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
});

const OutboxCountZ = CountZ.extend({ type: z.literal("outbox.count") });
const DraftContainsZ = z.object({ type: z.literal("draft.contains"), ...TextMatcherShape }).refine(oneMatcher, MATCHER_MSG);
const DraftNotContainsZ = z.object({ type: z.literal("draft.notContains"), ...TextMatcherShape }).refine(oneMatcher, MATCHER_MSG);
const DraftMaxWordsZ = z.object({ type: z.literal("draft.maxWords"), max: z.number().int().min(1) });
const DraftLintZ = z.object({ type: z.literal("draft.lintErrors"), equals: z.number().int().min(0).optional() });
const DraftNotToZ = z.object({ type: z.literal("draft.notTo"), email: z.string().min(3) });
const ContactStageZ = z.object({
  type: z.literal("contact.stage"),
  equals: StageZ.optional(),
  oneOf: z.array(StageZ).min(1).optional(),
});
const ContactExistsZ = z.object({ type: z.literal("contact.exists"), email: z.string().min(3) });
const ToolCalledZ = z.object({ type: z.literal("tool.called"), tool: z.string().min(1) });
const ToolNotCalledZ = z.object({ type: z.literal("tool.notCalled"), tool: z.string().min(1) });
const TaskCreatedZ = CountZ.extend({
  type: z.literal("task.created"),
  kind: z.string().min(1),
  /** Only count tasks scheduled at least this many hours ahead (follow-ups that are not "tomorrow"). */
  minWakeHours: z.number().min(0).optional(),
});

const LeafAssertionZ = z.union([
  ResultStatusZ,
  ResultDataZ,
  OutboxCountZ,
  DraftContainsZ,
  DraftNotContainsZ,
  DraftMaxWordsZ,
  DraftLintZ,
  DraftNotToZ,
  ContactStageZ,
  ContactExistsZ,
  ToolCalledZ,
  ToolNotCalledZ,
  TaskCreatedZ,
]);

export type LeafAssertion = z.infer<typeof LeafAssertionZ>;
export type EvalAssertion = LeafAssertion | { type: "any"; of: EvalAssertion[] };

export const AssertionZ: z.ZodType<EvalAssertion, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([LeafAssertionZ, z.object({ type: z.literal("any"), of: z.array(AssertionZ).min(2) })]),
);

export const EvalCaseZ = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "id must be a simple slug"),
  description: z.string().min(1),
  /** Task kind to run, e.g. "sdr.handle_reply". */
  kind: z.string().min(1),
  contact: z.object({
    email: z.string().email(),
    name: z.string().optional(),
    title: z.string().optional(),
    language: z.string().optional(),
    stage: StageZ.optional(),
    source: z.string().optional(),
    companyName: z.string().optional(),
    companyDomain: z.string().optional(),
    companyIndustry: z.string().optional(),
    companySize: z.string().optional(),
    companyCountry: z.string().optional(),
    attributes: z.record(z.unknown()).optional(),
  }),
  thread: z
    .object({
      sent: z.array(z.object({ subject: z.string(), body: z.string() })).default([]),
      inbound: z.array(z.object({ body: z.string(), subject: z.string().optional() })).default([]),
    })
    .optional(),
  /** Task input; contact name/email, company, replyBody and threadSummary are filled from the seed when absent. */
  input: z.record(z.unknown()).default({}),
  assertions: z.array(AssertionZ).min(1),
});

export type EvalCase = z.infer<typeof EvalCaseZ>;

export const SuiteConfigZ = z
  .object({
    /** Name the agents/KB use for "our company" inside the eval daemon. */
    companyName: z.string().min(1).default("Eval Co"),
    displayName: z.string().min(1).default("Mai"),
    /** Per-case wall-clock cap. */
    caseTimeoutMs: z.number().int().min(1000).default(480_000),
  })
  .default({});
export type SuiteConfig = z.infer<typeof SuiteConfigZ>;

export interface LoadedSuite {
  name: string;
  /** Absolute path of templates/<name>/evals. */
  dir: string;
  config: SuiteConfig;
  cases: EvalCase[];
  /** Absolute paths of evals/kb/*.md (ingested as company KB in each eval daemon). */
  kbFiles: string[];
}
