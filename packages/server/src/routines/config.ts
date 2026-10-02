// Per-kind routine config validation + defaults (shared by the routes and the runner).

import { z } from "zod";
import type { LeadStage, RoutineKind } from "@agyhq/core";
import { ValidationError } from "../util.ts";

export const LEAD_STAGES = [
  "new",
  "researching",
  "contacted",
  "replied",
  "qualified",
  "meeting_booked",
  "disqualified",
  "nurture",
] as const satisfies readonly LeadStage[];

export const MAX_BATCH_SIZE = 25;
export const DEFAULT_BATCH_SIZE = 5;

export const ProspectingConfigZ = z
  .object({
    batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).default(DEFAULT_BATCH_SIZE),
    stages: z.array(z.enum(LEAD_STAGES)).min(1).default(["new"]),
  })
  .strict();
export type ProspectingConfig = z.infer<typeof ProspectingConfigZ>;

export const PipelineReviewConfigZ = z
  .object({
    /** Contacts listed in the snapshot handed to the agent (most stale first). */
    maxContacts: z.number().int().min(1).max(200).default(40),
    staleAfterDays: z.number().int().min(1).max(90).default(7),
  })
  .strict();
export type PipelineReviewConfig = z.infer<typeof PipelineReviewConfigZ>;

export const CustomTaskConfigZ = z
  .object({
    kind: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    input: z.record(z.unknown()).default({}),
    priority: z.number().int().min(-100).max(100).optional(),
    threadKey: z.string().min(1).max(300).nullable().optional(),
  })
  .strict();
export type CustomTaskConfig = z.infer<typeof CustomTaskConfigZ>;

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(config)"}: ${i.message}`).join("; ");
}

/** Validate + normalize (apply defaults to) a routine's config; throws ValidationError with a readable message. */
export function parseRoutineConfig(kind: RoutineKind, config: Record<string, unknown>): Record<string, unknown> {
  const schema = kind === "prospecting" ? ProspectingConfigZ : kind === "pipeline_review" ? PipelineReviewConfigZ : CustomTaskConfigZ;
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new ValidationError(`invalid ${kind} config: ${zodMessage(parsed.error)}`);
  return parsed.data as Record<string, unknown>;
}

/** Lenient variant for runtime: a hand-edited bad config falls back to defaults instead of throwing. */
export function parseProspectingConfig(config: Record<string, unknown>): ProspectingConfig {
  const parsed = ProspectingConfigZ.safeParse(config);
  if (parsed.success) return parsed.data;
  const batch = typeof config["batchSize"] === "number" ? Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(config["batchSize"]))) : DEFAULT_BATCH_SIZE;
  const stages = Array.isArray(config["stages"])
    ? (config["stages"].filter((s): s is LeadStage => (LEAD_STAGES as readonly string[]).includes(String(s))) as LeadStage[])
    : [];
  return { batchSize: batch, stages: stages.length > 0 ? stages : ["new"] };
}
