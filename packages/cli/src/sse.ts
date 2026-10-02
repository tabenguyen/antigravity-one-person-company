// Minimal SSE (text/event-stream) line parser over a fetch Response body,
// used by `hq task watch`. Not a browser EventSource (that can't send a
// bearer Authorization header) — just a manual reader over the stream.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function readSse(response: Response, onEvent: (ev: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortHandler = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseChunk(chunk);
        if (ev) onEvent(ev);
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

function parseChunk(chunk: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith(":")) continue; // comment (e.g. the ": connected" keep-alive)
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
