import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Time-sortable id (ULID layout: 10 chars time + 16 chars randomness), with an optional prefix. */
export function newId(prefix?: string): string {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return prefix ? `${prefix}_${time}${rand}` : time + rand;
}

export const nowIso = (): string => new Date().toISOString();
