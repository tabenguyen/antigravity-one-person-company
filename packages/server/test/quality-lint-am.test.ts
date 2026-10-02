import { describe, expect, it } from "vitest";
import { lintDraft } from "../src/quality/lint.ts";
import { lintAccountManagerPromises } from "../src/quality/am-lint.ts";

const amCodes = (body: string, subject = "Re: Your question") =>
  lintDraft({ subject, body }, { role: "account-manager", hasPriorThread: true }).filter((f) => f.severity === "error").map((f) => f.code);

describe("account-manager promises are lint errors", () => {
  it.each([
    // refunds
    ["We will refund your last payment in full. Let me know if anything else comes up.", "am_refund_promise"],
    ["I'll process your refund today.", "am_refund_promise"],
    ["Your refund has been approved and will arrive in 5 days.", "am_refund_promise"],
    ["You'll get a full refund, no problem.", "am_refund_promise"],
    ["Chúng tôi sẽ hoàn tiền cho anh trong 3 ngày làm việc.", "am_refund_promise"],
    ["Em đồng ý hoàn tiền tháng này cho chị nhé.", "am_refund_promise"],
    ["Bên em sẽ hoàn lại phí cho anh ạ.", "am_refund_promise"],
    // discounts
    ["We can offer you a 20% discount on the next renewal.", "am_discount_promise"],
    ["I'll apply a discount to your invoice.", "am_discount_promise"],
    ["Great news: 15% off for the next three months.", "am_discount_promise"],
    ["Bên em sẽ giảm giá cho anh 10% nhé.", "am_discount_promise"],
    ["Em sẽ áp dụng ưu đãi đặc biệt cho chị.", "am_discount_promise"],
    // credits
    ["We'll credit your account for the downtime.", "am_credit_promise"],
    ["I can give you a free month to make up for it.", "am_credit_promise"],
    ["We'll add 2 extra months free to your plan.", "am_credit_promise"],
    ["Em sẽ tặng thêm 1 tháng sử dụng cho anh.", "am_credit_promise"],
    ["Bên em sẽ bù 2 tuần miễn phí cho chị.", "am_credit_promise"],
    // SLA / uptime
    ["Our uptime is 99.9% and we guarantee it.", "am_sla_promise"],
    ["We commit to a 4 hour response time under our SLA.", "am_sla_promise"],
    ["Hệ thống cam kết uptime 99,5% mỗi tháng.", "am_sla_promise"],
    ["Chúng tôi đảm bảo SLA phản hồi trong 2 giờ.", "am_sla_promise"],
    // delivery dates
    ["We will fix this bug by Friday.", "am_delivery_promise"],
    ["The new export feature will ship next week.", "am_delivery_promise"],
    ["We expect to release the patch in Q4.", "am_delivery_promise"],
    ["I promise the fix will be live within 48 hours.", "am_delivery_promise"],
    ["Tính năng này sẽ ra mắt vào tuần sau.", "am_delivery_promise"],
    ["Bên em sẽ khắc phục lỗi này trong vòng 2 ngày.", "am_delivery_promise"],
    ["Dự kiến phát hành bản vá vào cuối tháng.", "am_delivery_promise"],
    // contract changes
    ["We'll change your plan to the annual contract at the old price.", "am_contract_promise"],
    ["I can waive the early termination fee for you.", "am_contract_promise"],
    ["We will lock in your current pricing for two years.", "am_contract_promise"],
    ["We'll cancel your subscription from next month.", "am_contract_promise"],
    ["Bên em sẽ điều chỉnh hợp đồng của anh theo yêu cầu.", "am_contract_promise"],
    ["Em sẽ giữ nguyên giá gói này cho chị trong năm sau.", "am_contract_promise"],
  ])("flags: %s", (body, code) => {
    expect(amCodes(body)).toContain(code);
  });

  it.each([
    "Thanks for flagging this. I've passed your refund request to our team and they will come back to you. I can't promise an outcome yet.",
    "Unfortunately we can't offer a refund for this period; I've asked a colleague to review it.",
    "Chúng tôi chưa thể xác nhận hoàn tiền; em đã chuyển yêu cầu của anh tới bộ phận phụ trách.",
    "Em không thể hứa giảm giá, nhưng em sẽ chuyển câu hỏi về giá cho đội phụ trách.",
    "I can't commit to a delivery date for the fix, but I've logged your report with the team.",
    "To set a low-stock alert, open Settings, then Alerts, and choose a threshold per channel. Let me know how it goes.",
    "I'll send you the setup guide by tomorrow morning.",
    "Em sẽ gửi lại hướng dẫn cho anh trong hôm nay nhé.",
    "We don't offer discounts through support; the team will answer pricing questions.",
    "Please have your credit card details ready when you upgrade.",
    "Our team is reviewing your refund request and will update you.",
    "Em sẽ chuyển yêu cầu hoàn tiền của anh cho bộ phận phụ trách và báo lại anh.",
  ])("allows holding / ordinary replies: %s", (body) => {
    expect(amCodes(body)).toEqual([]);
  });

  it("skips the customer's own quoted lines", () => {
    const body = "Thanks, passing this on.\n\n> Can you refund me and give me a 20% discount? We'll refund you? \n> We will fix this bug by Friday.";
    expect(amCodes(body).filter((c) => c.startsWith("am_"))).toEqual([]); // (the quoted "20%" is still an ungrounded price)
  });

  it("a mixed sentence still flags the promise clause after a refusal", () => {
    expect(amCodes("We can't offer a refund, but we'll credit you one month free.")).toContain("am_credit_promise");
  });

  it("reports at most one finding per category, quoting the sentence", () => {
    const findings = lintAccountManagerPromises("We will refund you. We will also refund the setup fee. Thanks.");
    expect(findings.filter((f) => f.code === "am_refund_promise")).toHaveLength(1);
    expect(findings[0]!.message).toContain("We will refund you.");
  });

  it("applies only to the account-manager role", () => {
    const body = "We will refund your payment and give you a 20% discount.";
    const sdr = lintDraft({ subject: "Hi", body }, { role: "sales-sdr", hasPriorThread: true }).map((f) => f.code);
    expect(sdr.some((c) => c.startsWith("am_"))).toBe(false);
    expect(lintDraft({ subject: "Hi", body }, { hasPriorThread: true }).some((f) => f.code.startsWith("am_"))).toBe(false);
    expect(amCodes(body)).toEqual(expect.arrayContaining(["am_refund_promise", "am_discount_promise"]));
  });

  it("checks the subject line too", () => {
    expect(amCodes("Following up.", "Your refund has been approved")).toContain("am_refund_promise");
  });
});
