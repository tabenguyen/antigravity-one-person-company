// Small helpers shared by the inbound pipeline (inbound.ts) and the Sent-folder sync (sent-sync.ts): which addresses
// are "ours", and which conversation (threadKey) a message belongs to.

import type { Db } from "@agyhq/db";
import type { ParsedEmail } from "@agyhq/core";
import type { AgyhqConfig } from "./config.ts";
import { effectiveSender } from "./setup/sender-settings.ts";

/** Our own mailbox / sender addresses, lowercased. */
export function ourAddresses(config: AgyhqConfig, db: Db): string[] {
  const addrs: string[] = [];
  const senderAddress = effectiveSender(config, db).address;
  if (senderAddress) addrs.push(senderAddress.toLowerCase());
  if ("address" in config.email && config.email.address) addrs.push(config.email.address.toLowerCase());
  return [...new Set(addrs)];
}

/**
 * The thread an email continues, found through its In-Reply-To / References: a message we sent (outbox), a message we
 * received, or a message a human sent from their own mail client. Null when nothing we know of is referenced.
 */
export function threadFromHeaders(db: Db, headers: Pick<ParsedEmail, "inReplyTo" | "references">): string | null {
  const candidateIds = [headers.inReplyTo, ...headers.references].filter((x): x is string => !!x);
  for (const mid of candidateIds) {
    const outboxHit = db.outbox.findByMessageId(mid);
    if (outboxHit?.threadKey) return outboxHit.threadKey;
    const inboundHit = db.inbound.findByMessageId(mid);
    if (inboundHit?.threadKey) return inboundHit.threadKey;
    const humanHit = db.humanSent.findByMessageId(mid);
    if (humanHit?.threadKey) return humanHit.threadKey;
  }
  return null;
}
