---
name: qualify-lead
description: >-
  Use whenever asked to qualify a lead, score a lead, check ICP fit, or run
  BANT qualification on a prospect. Triggers on phrases like "qualify this
  lead," "is this a good lead," "score this prospect."
---

# Qualify a lead: ICP fit + BANT-lite

Two checks, in order. Do ICP fit first — a lead that fails ICP fit hard
doesn't need a full BANT workup.

## 1. ICP fit (pass/fail, with a reason)

Check against `kb/icp.md` (replace with {{companyName}}'s real criteria):
company size/segment, industry, geography, and the specific pain point the
product solves. A lead can score well on BANT and still be a bad fit (wrong
segment entirely) — flag that explicitly rather than forcing a BANT score
that implies they're worth pursuing.

- **Fit** → continue to BANT-lite below.
- **No fit** → `crm_set_stage` to `disqualified` with the specific reason
  (e.g. "Company size (3 employees) below ICP minimum (20+)"), log a note,
  and stop. Don't BANT-score a lead that fails fit.

## 2. BANT-lite scoring rubric (1–5 each, sum to a score out of 20)

Score only on evidence you actually have (from `research-lead`, the
prospect's own words, or CRM history) — never on assumption.

| | 1 (weak signal) | 3 (some signal) | 5 (strong signal) |
|---|---|---|---|
| **Budget** | Company size/stage suggests they can't realistically afford the product | Plausible budget, unconfirmed | Confirmed budget range or a size/revenue clearly above the product's typical price point |
| **Authority** | Contact's role has no visible influence on this kind of purchase | Likely an influencer, not the final decision-maker | Contact is the owner/decision-maker for this category of purchase |
| **Need** | No pain point matching the product found or mentioned | A plausible, inferred pain point, not confirmed by the prospect | Prospect directly described a pain point the product solves |
| **Timeline** | No urgency signal, long-term/exploratory | Some signal ("this quarter," "evaluating options") | Explicit near-term urgency ("before Tet," "need this live in 2 weeks") |

**Output format:**

```
BANT score: X/20 (Budget: n, Authority: n, Need: n, Timeline: n)
Reasoning: <one line per dimension, citing the actual evidence>
Recommendation: book-demo | nurture | disqualify
```

## Recommendation thresholds (tune per {{companyName}}'s actual conversion data — these are reasonable starting defaults)

- **15–20** → `book-demo`: strong enough to move to first-touch outreach now.
- **9–14** → `nurture`: real fit but not urgent/confirmed yet; enter the
  `follow-up-sequence` cadence instead of a hard pitch.
- **≤ 8** → `disqualify`, with the specific weak dimension(s) noted so a
  human reviewing later understands why.

Always `crm_set_stage` and `crm_add_note` with the score and reasoning —
the score without a reason is not useful to the next person.
