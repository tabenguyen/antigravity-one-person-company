import { stageLabel } from "../lib/roles.ts";

const TONE: Record<string, string> = {
  customer: "pill-success",
  churned: "pill-danger",
  meeting_booked: "pill-warning",
  qualified: "pill-warning",
};

/** Contact lifecycle stage as a badge; customer / churned get a colour so they stand out in lists. */
export function StageBadge({ stage }: { stage: string }) {
  const tone = TONE[stage];
  if (!tone) return <span className="chip">{stageLabel(stage)}</span>;
  return <span className={`pill ${tone} stage-badge`}>{stageLabel(stage)}</span>;
}
