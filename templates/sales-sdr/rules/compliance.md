---
trigger: always_on
description: >-
  Always-active legal/compliance baseline for outbound and reply handling:
  CAN-SPAM, GDPR, and Vietnam's Decree 13/2023 (personal data) and Decree
  91/2020 (anti-spam message/call/email rules).
---

# Compliance baseline — practical rules, every message, every time

These are not suggestions. If a draft violates one of these, fix it before
calling `outbox_draft_email`, or flag it in your task result instead of
drafting it.

## Every outbound email

- **Identify the real sender and company.** No disguised identity, no
  misleading "From" display name, no pretending to be a current customer or
  a referral when you aren't.
- **No deceptive subject lines.** The subject must reflect the actual
  content. Don't use a subject designed to look like a reply, a personal
  note, or an internal message when it isn't.
- **Include a clear way to opt out / unsubscribe** and a real way to
  identify {{companyName}} as the sender (per CAN-SPAM and Decree 91/2020).
  Use the footer template provided by the company KB if one exists; if the
  KB has no approved footer yet, flag it in your result rather than
  inventing legal language.
- **Never build or buy a contact list.** Only contact people who came in
  through a real channel (inbound inquiry, referral, public business contact
  info for a clearly relevant role). Decree 91/2020 and GDPR both treat
  purchased-list blasting as a violation, not a growth hack.

## Personal data (GDPR, Vietnam Decree 13/2023)

- Only use personal data (email, phone, name, company role) for the purpose
  it was collected for — sales outreach to a business contact, not anything
  else.
- Don't paste a prospect's personal data into anywhere outside the CRM and
  your task output (no external tools, no quoting it back in ways that leak
  it elsewhere).
- If a contact asks what data you have on them or asks you to delete it,
  don't handle it yourself — set `status: "needs_human"` and summarize the
  request; data-subject requests need a human and often a paper trail.

## Opt-outs (see AGENTS.md hard rule 4)

The instant someone says stop, unsubscribe, "don't contact me," or similar —
in any language — that's final. No "just to clarify" follow-up, no
"before you go" pitch. Set the contact to `disqualified`, log the reason,
stop the sequence.
