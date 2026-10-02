import { useMemo } from "react";
import { renderMarkdownToHtml } from "../lib/markdown.ts";

export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdownToHtml(source), [source]);
  // eslint-disable-next-line react/no-danger -- html is built entirely from
  // escaped text + tags we construct ourselves; see lib/markdown.ts.
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
