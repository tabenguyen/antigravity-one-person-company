# Sales Playbook — {{companyName}}

> **EXAMPLE — replace with {{companyName}}'s real product, pricing, and
> process.** Seed content for the role knowledge base (ingested by the
> agy-hq daemon). Every price, plan name, and claim below is a placeholder —
> an SDR agent must never repeat these example numbers as if they were real.

## Product summary

TODO — one paragraph: what {{companyName}} sells, who it's for, and the
single biggest outcome it delivers. (Example shape, not real content:
"{{companyName}} is an AI-powered inventory and order management platform
for small e-commerce retailers, syncing stock across marketplaces and a
retailer's own site in real time to prevent overselling.")

## Plans & published pricing (only quote what's listed here, verbatim)

| Plan | Price | Who it's for | Key limits/features |
|---|---|---|---|
| TODO — e.g. Starter | TODO — e.g. $49/mo | TODO | TODO |
| TODO — e.g. Growth | TODO — e.g. $199/mo | TODO | TODO |
| TODO — e.g. Scale | TODO — e.g. custom | TODO | TODO |

Any price not in this table does not exist as far as the SDR agent is
concerned — see the pricing-and-discounts rule.

## Approved value props (use these, don't invent new ones)

1. TODO
2. TODO
3. TODO

## Sales process / stages this role participates in

1. **Inbound/outbound lead arrives** → `research-lead`.
2. **Qualify** → `qualify-lead` (ICP fit + BANT-lite).
3. **First touch** → `write-first-touch`, draft via `outbox_draft_email`.
4. **No reply** → `follow-up-sequence` (day 3/7/14 cadence, see skill).
5. **Reply received** → `handle-reply` (classify and act).
6. **Meeting booked** → handoff to a human Account Executive — SDR's job on
   this lead is done; log the handoff clearly in the CRM.

## Competitive positioning (fill in real competitors; cite only what's here)

| Competitor | Where we're told we win | Where to be honest about trade-offs |
|---|---|---|
| TODO | TODO | TODO |

## Approved discount policy

TODO — e.g. "None. All discounts require Sales Manager approval; the SDR
role never offers one." Keep this in sync with the pricing-and-discounts
rule — that rule is the enforcement, this is the source fact.
