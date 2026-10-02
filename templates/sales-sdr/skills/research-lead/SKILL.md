---
name: research-lead
description: >-
  Use whenever asked to research a lead, company, or prospect before
  qualifying or reaching out — gathering facts from the web and internal
  systems before forming an opinion.
---

# Research a lead

Do this before you qualify or draft anything. The goal is facts with
sources, not a guess dressed up as research.

## Steps

1. **Pull what's already known internally first.** `crm_find_contact` by
   email/name/company. Read any existing notes — don't re-ask or re-research
   something already logged.
2. **Company basics** (via `search_web` / `read_url_content`): what they do,
   approximate size (employee count or store count if e-commerce/retail),
   industry, and anything public about growth stage (funding news, hiring,
   expansion).
3. **Signal for fit**, specific to {{companyName}}'s ICP (see
   `kb/icp.md`): look for the pain points {{companyName}}'s product
   solves — don't just confirm size/industry, look for an actual reason this
   company would care right now.
4. **The person**, not just the company: their title and what that implies
   about authority (see BANT "Authority" in `qualify-lead`). A generic
   "Contact Us" form submission with no name needs a different approach than
   a named decision-maker.
5. **Write it down before moving on.** `crm_add_note` with: what you found,
   where from (URL or "KB" or "prior CRM note"), and what's still unknown.
   Unknowns are fine to list — invented facts are not.

## What "done" looks like

A short internal note any teammate could read and understand: who they are,
what they likely need, what you're not sure about yet, and a recommendation
to qualify, nurture, or pass. Then hand off to `qualify-lead`.
