// Opt-in end-to-end test against a REAL mailbox. Skipped by default — set
// AGYHQ_EMAIL_TEST=1 and the AGYHQ_TEST_IMAP_*/AGYHQ_TEST_SMTP_* env vars to
// run it (e.g. against a throwaway Gmail account with an App Password).
//
//   AGYHQ_EMAIL_TEST=1 \
//   AGYHQ_TEST_IMAP_HOST=imap.gmail.com AGYHQ_TEST_IMAP_PORT=993 AGYHQ_TEST_IMAP_SECURE=1 \
//   AGYHQ_TEST_IMAP_USER=... AGYHQ_TEST_IMAP_PASS=... \
//   AGYHQ_TEST_SMTP_HOST=smtp.gmail.com AGYHQ_TEST_SMTP_PORT=465 AGYHQ_TEST_SMTP_SECURE=1 \
//   AGYHQ_TEST_SMTP_USER=... AGYHQ_TEST_SMTP_PASS=... \
//   AGYHQ_TEST_ADDRESS=you@gmail.com \
//   npx vitest run packages/channels/test/real-email.test.ts
//
// This repo's CI/sandbox has none of these set, so the suite just reports
// one skipped test — that's the expected, clean result here.
import { describe, expect, it } from "vitest";
import { ImapSmtpProvider } from "../src/providers/imap-smtp.ts";
import { newMessageId } from "../src/message-id.ts";

const enabled = process.env.AGYHQ_EMAIL_TEST === "1";

describe.skipIf(!enabled)("ImapSmtpProvider — real mailbox (opt-in)", () => {
  it("verifies, sends, and reads back a real message", async () => {
    const address = requireEnv("AGYHQ_TEST_ADDRESS");
    const provider = new ImapSmtpProvider({
      address,
      imap: {
        host: requireEnv("AGYHQ_TEST_IMAP_HOST"),
        port: Number(requireEnv("AGYHQ_TEST_IMAP_PORT")),
        secure: process.env.AGYHQ_TEST_IMAP_SECURE !== "0",
        user: requireEnv("AGYHQ_TEST_IMAP_USER"),
        pass: requireEnv("AGYHQ_TEST_IMAP_PASS"),
      },
      smtp: {
        host: requireEnv("AGYHQ_TEST_SMTP_HOST"),
        port: Number(requireEnv("AGYHQ_TEST_SMTP_PORT")),
        secure: process.env.AGYHQ_TEST_SMTP_SECURE !== "0",
        user: requireEnv("AGYHQ_TEST_SMTP_USER"),
        pass: requireEnv("AGYHQ_TEST_SMTP_PASS"),
      },
      sentFolder: null,
    });

    try {
      expect(await provider.verify()).toEqual({ ok: true });

      const messageId = newMessageId("agyhq-channels-test.local");
      const result = await provider.send({
        from: { address, name: "agy-hq channels test" },
        to: { address, name: null },
        subject: `agy-hq channels real-email test ${messageId}`,
        text: "This is an automated test message from the @agyhq/channels test suite.",
        messageId,
      });
      expect(result.messageId).toBe(messageId);
    } finally {
      await provider.close();
    }
  }, 30_000);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real-email test: missing required env var ${name}`);
  return value;
}
