import { describe, expect, it } from "vitest";
import { findInventedAvailability } from "../src/quality/availability-lint.ts";
import { lintDraft } from "../src/quality/lint.ts";
import { buildLintContext, hasPriorThread } from "../src/quality/lint-context.ts";
import { addAgent } from "./quality-helpers.ts";
import { openTestDb } from "./helpers.ts";

describe("findInventedAvailability", () => {
  it.each([
    "Worth a 15-minute call? I'm free Tuesday or Wednesday afternoon.",
    "We are available tomorrow morning if that helps.",
    "I'll be around Friday at 3pm.",
    "Does Thursday at 10:30 work for you?",
    "How about Monday?",
    "Are you free Thursday afternoon?",
    "Would tomorrow suit you?",
    "Thứ Ba mình rảnh, anh chị gọi được không?",
    "Em rảnh chiều mai, anh chị tiện không ạ?",
    "Mình rảnh lúc 3h chiều nay.",
    "Em rảnh vào thứ Năm.",
  ])("flags %s", (text) => {
    expect(findInventedAvailability(text).length).toBeGreaterThan(0);
  });

  it.each([
    "Would you be open to a short call? Reply with a time that suits you.",
    "Worth a quick call this week?",
    "Would this week work for a short call?",
    "Here is my calendar: https://cal.example.com/stocksync/intro",
    "Amazon is not available today, but Shopee and Lazada are.",
    "Your Shopee sale on Friday might oversell stock.",
    "Anh chị có rảnh để trao đổi nhanh không ạ?",
    "Em xin phép gửi thông tin trước, anh chị phản hồi giúp em nhé.",
    "I'm happy to answer questions anytime.",
  ])("leaves %s alone", (text) => {
    expect(findInventedAvailability(text)).toEqual([]);
  });
});

describe("invented_availability lint rule", () => {
  const body = "Hi Linh, worth a 15-minute call? I'm free Tuesday afternoon.";
  it("is a warning for the SDR role, never an error", () => {
    const f = lintDraft({ subject: "Stock sync", body }, { role: "sales-sdr", hasPriorThread: false }).find((x) => x.code === "invented_availability");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("i'm free tuesday");
  });

  it("only applies to the SDR role", () => {
    expect(lintDraft({ subject: "Hi", body }, { role: "account-manager", hasPriorThread: true }).map((f) => f.code)).not.toContain("invented_availability");
    expect(lintDraft({ subject: "Hi", body }, { hasPriorThread: true }).map((f) => f.code)).not.toContain("invented_availability");
  });

  it("is quiet for a low-friction question", () => {
    const ok = "Hi Linh, would a short call help? Reply with a time that suits you.";
    expect(lintDraft({ subject: "Stock sync", body: ok }, { role: "sales-sdr", hasPriorThread: false, contact: { name: "Linh Pham" } })).toEqual([]);
  });
});

describe("deceptive_subject with an inbound message", () => {
  it("an inbound event from the contact counts as the thread, so Re: of their subject is allowed", () => {
    const db = openTestDb();
    addAgent(db, "sdr-01");
    const agent = { id: "sdr-01", role: "sales-sdr" as const };
    const draft = { subject: "Re: Do you support Amazon?", body: "Hi An, not today. Want us to note it?" };
    expect(hasPriorThread(db, "an.le@example.com")).toBe(false);
    const before = lintDraft(draft, buildLintContext(db, { agent, to: "an.le@example.com" }));
    expect(before.find((f) => f.code === "deceptive_subject")?.severity).toBe("error");

    db.inbound.insertIfNew({
      source: "email",
      externalId: "m1",
      fromAddress: "An.Le@example.com",
      subject: "Do you support Amazon?",
      bodyText: "Hi, does StockSync work with Amazon?",
      classification: "new_lead",
      status: "routed",
    });
    expect(hasPriorThread(db, "an.le@example.com")).toBe(true);
    const after = lintDraft(draft, buildLintContext(db, { agent, to: "an.le@example.com" }));
    expect(after.map((f) => f.code)).not.toContain("deceptive_subject");
  });

  it("the refusal tells the agent what to do instead", () => {
    const f = lintDraft({ subject: "Re: hi", body: "Hello there. Worth a chat?" }, { hasPriorThread: false }).find((x) => x.code === "deceptive_subject");
    expect(f?.message).toContain("plain subject");
  });
});
