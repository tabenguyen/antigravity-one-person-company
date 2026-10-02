import { describe, expect, it } from "vitest";
import { FakeEmailProvider } from "../src/providers/fake.ts";

describe("FakeEmailProvider", () => {
  it("deliver() fills realistic defaults and fetchNew() drains them with an index cursor", async () => {
    const provider = new FakeEmailProvider();
    provider.deliver({ from: { address: "jane@acme.com", name: "Jane" }, text: "hi there" });
    provider.deliver({ from: { address: "bob@acme.com", name: "Bob" }, text: "actual reply\n\n> quoted history" });

    const first = await provider.fetchNew(null, { limit: 1 });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.from).toEqual({ address: "jane@acme.com", name: "Jane" });
    expect(first.messages[0]!.messageId).toMatch(/@fake\.test$/);
    expect(first.cursor).toBe("0");

    const second = await provider.fetchNew(first.cursor);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.from!.address).toBe("bob@acme.com");
    expect(second.messages[0]!.replyText).toBe("actual reply");
    expect(second.cursor).toBe("1");

    const none = await provider.fetchNew(second.cursor);
    expect(none.messages).toHaveLength(0);
    expect(none.cursor).toBe("1");
  });

  it("send() records outgoing mail and returns an accepted SendResult", async () => {
    const provider = new FakeEmailProvider();
    const result = await provider.send({
      from: { address: "mai@agyhq.test", name: "Mai" },
      to: { address: "jane@acme.com", name: "Jane" },
      subject: "Hi",
      text: "hello",
      messageId: "m1@agyhq.test",
    });
    expect(result.accepted).toEqual(["jane@acme.com"]);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.messageId).toBe("m1@agyhq.test");
  });

  it("failNextSend() makes the next send() throw exactly once", async () => {
    const provider = new FakeEmailProvider();
    const boom = new Error("smtp down");
    provider.failNextSend(boom);

    const email = {
      from: { address: "mai@agyhq.test", name: "Mai" },
      to: { address: "jane@acme.com", name: "Jane" },
      subject: "Hi",
      text: "hello",
      messageId: "m2@agyhq.test",
    };
    await expect(provider.send(email)).rejects.toThrow("smtp down");
    await expect(provider.send(email)).resolves.toMatchObject({ messageId: "m2@agyhq.test" });
    expect(provider.sent).toHaveLength(1);
  });

  it("setVerify() controls verify() output", async () => {
    const provider = new FakeEmailProvider();
    expect(await provider.verify()).toEqual({ ok: true });
    provider.setVerify({ ok: false, error: "nope" });
    expect(await provider.verify()).toEqual({ ok: false, error: "nope" });
  });
});
