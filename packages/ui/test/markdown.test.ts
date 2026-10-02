// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml } from "../src/lib/markdown.ts";

describe("renderMarkdownToHtml", () => {
  it("escapes raw HTML instead of injecting it", () => {
    const html = renderMarkdownToHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders headings, lists, bold and inline code", () => {
    const html = renderMarkdownToHtml(["# Title", "", "- one", "- **two**", "", "Some `code` here."].join("\n"));
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li><strong>two</strong></li>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders fenced code blocks verbatim (escaped) without interpreting markup inside", () => {
    const html = renderMarkdownToHtml(["```", "**not bold** <b>not html</b>", "```"].join("\n"));
    expect(html).toContain("<pre><code>");
    expect(html).toContain("&lt;b&gt;not html&lt;/b&gt;");
    expect(html).not.toContain("<strong>");
  });

  it("keeps safe http(s)/mailto links but drops unsafe schemes", () => {
    const safe = renderMarkdownToHtml("[docs](https://example.com/a)");
    expect(safe).toContain('<a href="https://example.com/a"');

    const unsafe = renderMarkdownToHtml("[click me](javascript:alert(1))");
    expect(unsafe).not.toContain("<a ");
    expect(unsafe).toContain("click me");
  });
});
