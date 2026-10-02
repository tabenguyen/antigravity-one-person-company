/**
 * Heading-aware markdown chunker: splits on `#`-headings first (so each chunk stays
 * within one section), then packs paragraphs up to ~targetSize chars, carrying a
 * small tail of the previous chunk forward as overlap so a search hit near a
 * chunk boundary still has context on both sides.
 */
export function chunkMarkdown(body: string, targetSize = 800, overlap = 100): string[] {
  const lines = body.split("\n");
  const sections: { heading: string; text: string }[] = [];
  let currentHeading = "";
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading: currentHeading, text });
    buf = [];
  };

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      currentHeading = line.replace(/^#{1,6}\s*/, "").trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    const whole = body.trim();
    return whole ? [whole] : [];
  }

  const chunks: string[] = [];
  for (const section of sections) {
    const prefix = section.heading ? `${section.heading}\n\n` : "";
    if (prefix.length + section.text.length <= targetSize) {
      chunks.push((prefix + section.text).trim());
      continue;
    }

    const paragraphs = section.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    let current = prefix;
    for (const paragraph of paragraphs) {
      const wouldOverflow = current.length > prefix.length && current.length + paragraph.length + 2 > targetSize;
      if (wouldOverflow) {
        chunks.push(current.trim());
        const tail = current.slice(-overlap);
        current = prefix + tail + "\n\n" + paragraph;
      } else {
        current += (current.length > prefix.length ? "\n\n" : "") + paragraph;
      }
    }
    if (current.trim() && current.trim() !== prefix.trim()) chunks.push(current.trim());
  }
  return chunks;
}
