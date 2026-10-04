import type { AgentRole, LeadStage } from "../api/types.ts";

export const ROLES: AgentRole[] = ["sales-sdr", "account-manager", "chief-of-staff", "fanpage-manager"];

export const ROLE_INFO: Record<AgentRole, { label: string; description: string }> = {
  "sales-sdr": {
    label: "Sales SDR",
    description: "Researches leads, drafts first-touch and follow-up emails, and answers prospect replies.",
  },
  "account-manager": {
    label: "Account Manager",
    description: "Owns customers after a won deal: onboarding, customer questions, check-ins and escalations.",
  },
  "chief-of-staff": {
    label: "Chief of Staff",
    description: "Internal only: triages inbound mail nothing else owns and writes your daily briefing.",
  },
  "fanpage-manager": {
    label: "Fanpage Manager",
    description: "Drafts Facebook Page posts (news, features, releases) and answers or moderates comments. Everything waits for your approval; approved posts are only scheduled.",
  },
};

export function roleLabel(role: string): string {
  return ROLE_INFO[role as AgentRole]?.label ?? role;
}

/** Contact lifecycle stages, in funnel order. */
export const STAGES: LeadStage[] = [
  "new",
  "researching",
  "contacted",
  "replied",
  "qualified",
  "meeting_booked",
  "customer",
  "churned",
  "nurture",
  "disqualified",
];

export function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ");
}
