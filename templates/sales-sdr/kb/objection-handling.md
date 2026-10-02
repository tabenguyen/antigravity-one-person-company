# Objection Handling Reference — {{companyName}}

> **EXAMPLE — replace with {{companyName}}'s real, approved responses.**
> Seed content for the role knowledge base (ingested by the agy-hq daemon).
> This file supplies the *facts* the `objection-handling` rule and skill are
> allowed to cite — if an objection response isn't grounded here, the agent
> should say "I'll check" rather than improvise one.

## "It's too expensive"

TODO — approved response pattern, e.g. ROI framing, cost-of-inaction framing
specific to {{companyName}}'s product. Do not include an actual discount
offer here — that's handled by a human, never by this file.

## "We already use [competitor]"

TODO — per-competitor approved talking points. Keep factual and specific;
avoid disparaging language — the goal is honest differentiation, not
trashing a competitor.

| Competitor | Approved differentiation | Don't claim |
|---|---|---|
| TODO | TODO | TODO |

## "Not the right time"

TODO — approved reframing (e.g. "what would need to be true for the timing
to work?") and when to route to `nurture` instead of pushing.

## "Need to check with my boss / team"

TODO — approved offer (e.g. "I can send a short summary you can forward" —
only if that's actually an approved, real asset) and how to keep the thread
alive without pressuring.

## Security / compliance / data-handling concerns

TODO — this should almost always route to a human with real technical/legal
authority. List here only what's safe for an SDR agent to say verbatim
(e.g. a link to a public security page), not improvised compliance claims.

## Flat "not interested"

No talking points needed — see AGENTS.md hard rules and the
`objection-handling` skill: acknowledge, don't argue, log it, move on.
