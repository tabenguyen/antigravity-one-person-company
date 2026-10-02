import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadTemplate, renderPrompt } from "../src/index.ts";

const templatesRoot = path.resolve(import.meta.dirname, "../../../templates");
const template = loadTemplate(templatesRoot, "sales-sdr");

describe("renderPrompt", () => {
  it("renders sdr.research_lead with task input substituted", () => {
    const text = renderPrompt(template, "sdr.research_lead", {
      contactName: "Linh Nguyen",
      contactEmail: "linh@hanoifashion.example.com",
      leadCompanyName: "Hanoi Fashion Chain",
      leadCompanyDomain: "hanoifashion.example.com",
      context: "Inbound demo request",
    });
    expect(text).toContain("Linh Nguyen");
    expect(text).toContain("linh@hanoifashion.example.com");
    expect(text).toContain("Hanoi Fashion Chain");
    expect(text).toContain("Inbound demo request");
    expect(text).not.toMatch(/\{\{.*\}\}/);
  });

  it("renders sdr.handle_reply and stringifies non-string input values", () => {
    const text = renderPrompt(template, "sdr.handle_reply", {
      contactName: "Hoa Tran",
      contactEmail: "hoa@example.com",
      threadSummary: ["touch 1 sent", "no reply"],
      replyBody: "Please unsubscribe me.",
    });
    expect(text).toContain("Hoa Tran");
    expect(text).toContain("Please unsubscribe me.");
    expect(text).toContain(JSON.stringify(["touch 1 sent", "no reply"]));
  });

  it("throws for an unknown task kind", () => {
    expect(() => renderPrompt(template, "sdr.not_a_real_kind", {})).toThrow(/Unknown task kind/);
  });

  it("renders missing input fields as (not provided) and appends the raw input", () => {
    const out = renderPrompt(template, "sdr.first_touch", {
      contactName: "Linh",
      note: "extra field not in the template",
      // contactEmail, leadCompanyName, qualificationSummary, bantScore intentionally omitted
    });
    expect(out).toContain("Linh");
    expect(out).toContain("(not provided)");
    expect(out).not.toMatch(/\{\{/);
    expect(out).toContain("## Task input (raw)");
    expect(out).toContain("extra field not in the template");
  });
});
