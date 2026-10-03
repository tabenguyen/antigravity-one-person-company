// Lint reads only what the agent wrote: "Re: <customer's subject>" is an echo, not a promise / price / placeholder.
import { describe, expect, it } from "vitest";
import { mcpRoute } from "@agyhq/core";
import { agentWrittenSubject, splitEchoedSubject, stripReplyPrefixes } from "../src/quality/echoed-subject.ts";
import { lintDraft, type LintContext } from "../src/quality/lint.ts";
import { threadInboundSubjects } from "../src/quality/lint-context.ts";
import { setupTestApi } from "./agent-api/test-helpers.ts";

const HOLDING = "Hi Binh,\n\nThanks for flagging this. I've passed your request to a teammate who will reply to you personally.\nTell me if anything changes on your side.\n\nLinh";
const am = (subject: string, body: string, threadSubjects: string[] | undefined, extra: Partial<LintContext> = {}) =>
  lintDraft({ subject, body }, { role: "account-manager", hasPriorThread: true, threadSubjects, ...extra });
const errCodes = (f: ReturnType<typeof lintDraft>) => f.filter((x) => x.severity === "error").map((x) => x.code);

describe("stripReplyPrefixes / splitEchoedSubject", () => {
  it.each([
    ["Re: Hello", "Hello"],
    ["RE: RE: Re: Hello", "Hello"],
    ["Re[2]: Hello", "Hello"],
    ["Fwd: Re: Hello", "Hello"],
    ["FW: Hello", "Hello"],
    ["TL: Hello", "Hello"],
    ["Trả lời: Hello", "Hello"],
    ["Tra loi : Re: Hello", "Hello"],
    ["Chuyển tiếp: Trả lời: Hello", "Hello"],
    ["Reply: Hello", "Reply: Hello"], // not a prefix
  ])("%s -> %s", (input, out) => expect(stripReplyPrefixes(input)).toBe(out));

  it("matches ignoring case, whitespace runs and prefix chains on both sides", () => {
    const s = splitEchoedSubject("RE:   uptime  GUARANTEE for our board paper", ["Fwd: Re: Uptime guarantee for our board paper"]);
    expect(s).toMatchObject({ echoed: true, added: "" });
  });

  it("returns the text added after the echo and nothing of the echo", () => {
    const s = splitEchoedSubject("Re: Refund request - we will refund you", ["Refund request"]);
    expect(s).toMatchObject({ echoed: true, echo: "Refund request", added: "we will refund you" });
  });

  it("is not an echo when the agent text comes first, the echo ends mid-word, or nothing is known", () => {
    expect(splitEchoedSubject("Re: We guarantee uptime", ["uptime"]).echoed).toBe(false);
    expect(splitEchoedSubject("Re: Refunds policy", ["Refund"]).echoed).toBe(false);
    expect(splitEchoedSubject("Re: Refund request", []).echoed).toBe(false);
    expect(splitEchoedSubject("Re: Refund request", undefined).echoed).toBe(false);
    expect(agentWrittenSubject("Re: We guarantee uptime", ["uptime"])).toBe("Re: We guarantee uptime");
  });

  it("handles Vietnamese subjects with diacritics (NFC / NFD)", () => {
    const known = "Cam kết uptime cho báo cáo hội đồng".normalize("NFD");
    expect(splitEchoedSubject("Trả lời: Cam kết uptime cho báo cáo hội đồng", [known])).toMatchObject({ echoed: true, added: "" });
  });
});

describe("account-manager lint ignores an echoed customer subject", () => {
  it.each([
    "Uptime guarantee for our board paper",
    "Can you guarantee 99.9% uptime?",
    "Refund request",
    "I want a refund and a 20% discount",
    "Please waive the early termination fee",
  ])("Re: %s", (their) => {
    // Without the thread knowledge the same subject is refused (proves the fixture is a real false positive).
    const naked = errCodes(am(`Re: ${their}`, HOLDING, undefined)).filter((c) => c.startsWith("am_"));
    const echoed = errCodes(am(`Re: ${their}`, HOLDING, [their])).filter((c) => c.startsWith("am_"));
    expect(echoed).toEqual([]);
    if (their !== "Refund request") expect(naked.length).toBeGreaterThan(0);
  });

  it("covers every reply prefix and prefix chain, case and spacing", () => {
    const their = "Uptime guarantee for our board paper";
    for (const prefix of ["Re:", "RE:", "re:", "Fwd:", "Fw:", "TL:", "Trả lời:", "RE: RE:", "Re: Fwd: Re:", "Re[2]:"]) {
      expect(errCodes(am(`${prefix} ${their.toUpperCase()}`, HOLDING, [`RE: ${their}`])), prefix).toEqual([]);
    }
    expect(errCodes(am(`Re: ${their}`, HOLDING, ["Hello", "Older thing", their]))).toEqual([]);
  });

  it("Vietnamese customer subjects", () => {
    const their = "Xin cam kết uptime 99,9% và hoàn tiền nếu thấp hơn";
    const body = "Chào anh Bình,\n\nEm đã chuyển yêu cầu của anh tới đồng nghiệp phụ trách, bạn ấy sẽ trả lời anh trực tiếp. Anh cần gì thêm cứ nhắn em nhé.\n\nLinh";
    expect(errCodes(am(`Trả lời: ${their}`, body, [their]))).toEqual([]);
    expect(errCodes(am(`TL: ${their}`, body, undefined)).some((c) => c.startsWith("am_"))).toBe(true);
  });

  it("still flags a promise the agent adds to the subject (alone, or next to an echo)", () => {
    const their = "Refund request";
    expect(errCodes(am(`Re: ${their} - we will refund you in full`, HOLDING, [their]))).toContain("am_refund_promise");
    expect(errCodes(am("Re: We guarantee 99.9% uptime", HOLDING, ["Uptime question"]))).toContain("am_sla_promise");
    expect(errCodes(am(`Re: ${their} approved - your refund has been approved`, HOLDING, [their]))).toContain("am_refund_promise");
    // the agent's addition combines with the echo into a promise the echo alone does not make
    expect(errCodes(am("Re: Refund request - refund is approved", HOLDING, ["Refund request"]))).toContain("am_refund_promise");
    // a subject that only borrows the customer's words, with the agent's own promise in front of them
    expect(errCodes(am("Re: We guarantee uptime", HOLDING, ["uptime"]))).toContain("am_sla_promise");
  });

  it("still flags genuine promises in the body even when the subject is a pure echo", () => {
    const their = "Uptime guarantee for our board paper";
    expect(errCodes(am(`Re: ${their}`, "Yes, we guarantee 99.9% uptime. Let me know if you need anything else.", [their]))).toContain("am_sla_promise");
    expect(errCodes(am("Re: Refund request", "We will refund your last payment in full. Anything else?", ["Refund request"]))).toContain("am_refund_promise");
    expect(errCodes(am("Re: Refund request", "Chúng tôi sẽ hoàn tiền cho anh trong 3 ngày.", ["Refund request"]))).toContain("am_refund_promise");
  });

  it("does not exempt a subject unrelated to the thread", () => {
    expect(errCodes(am("Your refund has been approved", HOLDING, ["Quick question"]))).toContain("am_refund_promise");
    expect(errCodes(am("Re: Your refund has been approved", HOLDING, ["Quick question"]))).toContain("am_refund_promise");
  });

  it("keeps skipping quoted ('>') lines in the body", () => {
    const body = `${HOLDING}\n\nOn Tue, Binh wrote:\n> Can you guarantee 99.9% uptime and refund us if it drops?\n>> We will refund you`;
    const codes = errCodes(am("Re: Uptime guarantee", body, ["Uptime guarantee"])).filter((c) => c.startsWith("am_"));
    expect(codes).toEqual([]);
  });
});

describe("SDR rules ignore an echoed customer subject too", () => {
  const sdr = (subject: string, body: string, threadSubjects?: string[]) =>
    lintDraft({ subject, body }, { role: "sales-sdr", hasPriorThread: true, threadSubjects, kbText: "NK Invoice starts at 99.000đ/tháng" });

  it("placeholder-looking and priced customer subjects do not fail the reply", () => {
    for (const their of ["[Action required] Báo giá gói 2 triệu/tháng?", "Quote for the {Team} plan at $500/month"]) {
      const body = "Chào anh, em đã nhận được câu hỏi và sẽ gửi thông tin chi tiết. Anh rảnh trao đổi nhanh không?";
      expect(errCodes(sdr(`Re: ${their}`, body)).length).toBeGreaterThan(0);
      expect(errCodes(sdr(`Re: ${their}`, body, [their]))).toEqual([]);
    }
  });

  it("text the SDR adds to the subject is still linted; deceptive_subject is unchanged", () => {
    const their = "Báo giá gói 2 triệu/tháng?";
    const body = "Chào anh, em gửi thông tin. Anh rảnh trao đổi nhanh không?";
    expect(errCodes(sdr(`Re: ${their} [Name]`, body, [their]))).toContain("placeholder");
    expect(errCodes(sdr(`Re: ${their} chỉ 3 triệu/tháng`, body, [their]))).toContain("unknown_price");
    // "Re:" with no prior thread is still refused, echo or not
    const f = lintDraft({ subject: `Re: ${their}`, body }, { role: "sales-sdr", hasPriorThread: false, threadSubjects: [their], kbText: "" });
    expect(errCodes(f)).toContain("deceptive_subject");
  });
});

describe("threadInboundSubjects / draft-time wiring", () => {
  it("collects the contact's inbound subjects (by address or thread), newest first, deduped", () => {
    const t = setupTestApi();
    const ins = (externalId: string, subject: string | null, extra: Record<string, unknown> = {}) =>
      t.db.inbound.insertIfNew({ source: "email", externalId, fromAddress: "binh@anphu.example", subject, bodyText: "x", classification: "reply", ...extra });
    ins("a", "Old thing", { receivedAt: "2026-10-01T00:00:00.000Z" });
    ins("b", "Uptime guarantee for our board paper", { receivedAt: "2026-10-02T00:00:00.000Z", threadKey: "T1" });
    ins("c", "Uptime guarantee for our board paper", { receivedAt: "2026-10-03T00:00:00.000Z", threadKey: "T1" });
    ins("d", null, { receivedAt: "2026-10-03T01:00:00.000Z" });
    t.db.inbound.insertIfNew({ source: "email", externalId: "e", fromAddress: "other@x.example", subject: "Other contact", bodyText: "x", classification: "reply", threadKey: "T9" });
    expect(threadInboundSubjects(t.db, "Binh@Anphu.example", "T1")).toEqual(["Uptime guarantee for our board paper", "Old thing"]);
  });

  it("outbox_draft_email accepts an AM 'Re: <their subject>' reply but refuses an added promise", async () => {
    const t = setupTestApi();
    const am = t.db.agents.create({
      id: "am-01",
      role: "account-manager",
      displayName: "Linh",
      model: "m",
      workspacePath: "/tmp/workspaces/am-01",
      policy: { builtins: [], mcp: [{ server: "company", tool: "outbox_draft_email" }] },
    });
    const their = "Uptime guarantee for our board paper";
    t.db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "binh@anphu.example", subject: their, bodyText: "Can you confirm 99.9% uptime?", threadKey: "TH", classification: "reply" });
    const call = async (subject: string, body: string, kind = "am.handle_message") => {
      const task = t.db.tasks.create({ agentId: am.id, kind, title: "msg", threadKey: "TH" });
      const res = await t.app.request(mcpRoute("outbox_draft_email"), {
        method: "POST",
        headers: { authorization: `Bearer ${t.tokens.issue(am.id, task.id)}`, "x-agyhq-agent-id": am.id, "x-agyhq-task-id": task.id, "content-type": "application/json" },
        body: JSON.stringify({ to: "binh@anphu.example", subject, body, reason: "holding reply" }),
      });
      return { status: res.status, json: (await res.json()) as { ok: boolean; error?: { message: string } } };
    };

    // refused first (a refused draft stores nothing), then the plain echo is accepted
    const bad = await call(`Re: ${their} - we guarantee 99.9% uptime`, HOLDING);
    expect(bad.status).toBe(400);
    expect(bad.json.error?.message).toContain("am_sla_promise");

    const ok = await call(`Re: ${their}`, HOLDING);
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
  });
});

describe("am_sla_promise: only a pure acknowledgement / hand-off is exempt (fail-closed)", () => {
  const body = (line: string) => `Hi Binh,\n\n${line}\nTell me if anything changes on your side.\n\nLinh`;
  const sla = (line: string) => errCodes(am("Re: Question", body(line), undefined)).includes("am_sla_promise");

  it.each([
    "I received your request regarding the uptime guarantee and compensation terms; I've passed it to our team.",
    "I received your request regarding the uptime guarantee and compensation terms for your board paper.",
    "Thanks for your question about the uptime guarantee, I've passed it to a teammate.",
    "I've passed your question about the SLA to our team.",
    "You asked about an uptime commitment, so I've asked a colleague to reply to you personally.",
    "Em đã nhận được yêu cầu của anh về cam kết uptime, em chuyển cho đồng nghiệp phụ trách.",
    "Em đã chuyển câu hỏi của anh về SLA cho bộ phận phụ trách.",
  ])("not flagged: %s", (line) => expect(sla(line)).toBe(false));

  it.each([
    "I received your request regarding the uptime guarantee and passed it on, consider it done.",
    "Em đã nhận yêu cầu của anh về cam kết uptime, bên em đồng ý ạ.",
    "I've passed your question about the uptime guarantee to the team and it is approved.",
    // the reviewer's probes
    "Regarding your request about the uptime guarantee, we will make sure you get 99.9%.",
    "Thanks for your email about the uptime guarantee — that will be fine for your board paper.",
    "Per your request, the uptime guarantee is included in your plan.",
    "You asked about uptime - yes, we have a 99.9% uptime guarantee.",
    "About your question on uptime: you'll have 99.9% uptime guaranteed.",
    // earlier cases
    "As you asked, uptime is 99.9%.",
    "In response to your request, we guarantee 99.9% uptime.",
    "Regarding your question: we commit to an SLA of four hours.",
    "Per your email, we confirm the uptime guarantee.",
    "I received your request and our uptime is guaranteed at 99.95%.",
    "Our uptime guarantee applies to your account.",
    // acknowledgement + hidden claim, in either clause order, with or without figures
    "I received your request about the uptime guarantee, and it covers your plan.",
    "I've passed your question about uptime to the team, uptime guarantee confirmed.",
    "I've passed your question to the team - the uptime guarantee stands.",
    "I've passed your request on; five nines uptime guarantee applies.",
    "I received your request regarding the uptime guarantee, we'll honour it for your board paper.",
    "I received your request regarding the uptime guarantee and a teammate will reply within a day.",
    "I received your request: SLA guarantee, sure, no problem.",
    // Vietnamese
    "Em xác nhận cam kết uptime theo yêu cầu của anh.",
    "Em đã chuyển yêu cầu của anh về uptime cho đồng nghiệp, uptime 99,9% sẽ được đảm bảo.",
    "Em đã nhận yêu cầu của anh về cam kết uptime, bên em sẽ đảm bảo.",
    "Em đã nhận được yêu cầu của anh về uptime - vâng, có cam kết uptime trong gói.",
    "Theo yêu cầu của anh, cam kết uptime đã được bao gồm trong gói.",
    "Em đã chuyển câu hỏi của anh, hệ thống cam kết uptime cho gói của anh.",
  ])("flagged: %s", (line) => expect(sla(line)).toBe(true));
});
