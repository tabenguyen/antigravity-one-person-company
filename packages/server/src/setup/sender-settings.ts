// Sender identity + unsubscribe address, editable at runtime from the setup wizard.
// kv "sender_settings" (all four fields, or absent) overrides config.sender / config.unsubscribeMailto everywhere:
// the Sender (From, footer, List-Unsubscribe), inbound own-address detection and the readiness checks all go through
// effectiveSender() so they can never disagree.

import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "../config.ts";
import { SenderSettingsInputZ, type SenderSettingsInput } from "../admin-types.ts";

export const SENDER_SETTINGS_KEY = "sender_settings";

export interface EffectiveSender extends SenderSettingsInput {
  source: "ui" | "config";
}

export function loadStoredSender(db: Db): SenderSettingsInput | null {
  const raw = db.kv.get<unknown>(SENDER_SETTINGS_KEY);
  if (!raw) return null;
  const parsed = SenderSettingsInputZ.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function saveSender(db: Db, input: SenderSettingsInput): void {
  db.kv.set(SENDER_SETTINGS_KEY, { ...input, updatedAt: new Date().toISOString() });
}

/** UI settings if present, else the config file's sender/unsubscribeMailto. */
export function effectiveSender(config: AgyhqConfig, db: Db): EffectiveSender {
  const stored = loadStoredSender(db);
  if (stored) return { ...stored, source: "ui" };
  return {
    name: config.sender.name,
    address: config.sender.address,
    companyAddressLine: config.sender.companyAddressLine,
    unsubscribeMailto: config.unsubscribeMailto,
    source: "config",
  };
}
