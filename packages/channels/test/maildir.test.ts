import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MaildirProvider } from "../src/providers/maildir.ts";
import { parseRawEmail } from "../src/parse.ts";
import { readFixture } from "./helpers.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agyhq-maildir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("MaildirProvider", () => {
  it("round-trips: deliver .eml files → fetchNew → cursor → no duplicates", async () => {
    const provider = new MaildirProvider({ root, address: "mai@agyhq.test", displayName: "Mai" });

    await mkdir(path.join(root, "inbox"), { recursive: true });
    const raw1 = await readFixture("plain-reply-en.eml");
    const raw2 = await readFixture("vi-reply.eml");
    await writeFile(path.join(root, "inbox", "0001.eml"), raw1);
    await writeFile(path.join(root, "inbox", "0002.eml"), raw2);

    const first = await provider.fetchNew(null);
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0]!.from!.address).toBe("jane@acme.com");
    expect(first.messages[1]!.from!.address).toBe("a.nguyen@congty.vn");
    expect(first.cursor).toBe("0002.eml");

    // No duplicates on a repeat fetch from the saved cursor.
    const second = await provider.fetchNew(first.cursor);
    expect(second.messages).toHaveLength(0);
    expect(second.cursor).toBe("0002.eml");

    // A newly arrived message is picked up from the cursor.
    await writeFile(path.join(root, "inbox", "0003.eml"), await readFixture("unsubscribe-en.eml"));
    const third = await provider.fetchNew(second.cursor);
    expect(third.messages).toHaveLength(1);
    expect(third.messages[0]!.from!.address).toBe("tom@smallbiz.example");
    expect(third.cursor).toBe("0003.eml");
  });

  it("restarts from the beginning if the cursor file no longer exists", async () => {
    const provider = new MaildirProvider({ root, address: "mai@agyhq.test" });
    await mkdir(path.join(root, "inbox"), { recursive: true });
    await writeFile(path.join(root, "inbox", "0002.eml"), await readFixture("plain-reply-en.eml"));

    const result = await provider.fetchNew("0001.eml");
    expect(result.messages).toHaveLength(1);
    expect(result.cursor).toBe("0002.eml");
  });

  it("respects the limit option", async () => {
    const provider = new MaildirProvider({ root, address: "mai@agyhq.test" });
    await mkdir(path.join(root, "inbox"), { recursive: true });
    await writeFile(path.join(root, "inbox", "0001.eml"), await readFixture("plain-reply-en.eml"));
    await writeFile(path.join(root, "inbox", "0002.eml"), await readFixture("vi-reply.eml"));

    const result = await provider.fetchNew(null, { limit: 1 });
    expect(result.messages).toHaveLength(1);
    expect(result.cursor).toBe("0001.eml");
  });

  it("send() writes a real MIME file with the exact Message-ID/In-Reply-To/References/List-Unsubscribe", async () => {
    const provider = new MaildirProvider({ root, address: "mai@agyhq.test", displayName: "Mai" });

    const outgoing = {
      from: { address: "mai@agyhq.test", name: "Mai" },
      to: { address: "jane@acme.com", name: "Jane" },
      subject: "Re: Quick question",
      text: "Thanks, Tuesday works great.",
      messageId: "sent-001@agyhq.test",
      inReplyTo: "reply-001@mail.acme.com",
      references: ["outreach-001@agyhq.test", "reply-001@mail.acme.com"],
      listUnsubscribe: "<mailto:unsubscribe@agyhq.test?subject=unsubscribe>",
    };

    const result = await provider.send(outgoing);
    expect(result.messageId).toBe("sent-001@agyhq.test");
    expect(result.accepted).toEqual(["jane@acme.com"]);

    const sentPath = path.join(root, "sent", "sent-001@agyhq.test.eml");
    const raw = await readFile(sentPath);
    const parsed = await parseRawEmail(raw, "sent-001@agyhq.test.eml");

    expect(parsed.messageId).toBe("sent-001@agyhq.test");
    expect(parsed.inReplyTo).toBe("reply-001@mail.acme.com");
    expect(parsed.references).toEqual(["outreach-001@agyhq.test", "reply-001@mail.acme.com"]);
    expect(parsed.headers["list-unsubscribe"]).toBe("<mailto:unsubscribe@agyhq.test?subject=unsubscribe>");
    expect(parsed.subject).toBe("Re: Quick question");
    expect(parsed.text).toContain("Tuesday works great");
  });

  it("verify() creates inbox/sent and reports ok", async () => {
    const provider = new MaildirProvider({ root: path.join(root, "nested"), address: "mai@agyhq.test" });
    expect(await provider.verify()).toEqual({ ok: true });
  });
});
