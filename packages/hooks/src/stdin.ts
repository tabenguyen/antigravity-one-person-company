// Reads the agy hook JSON payload from stdin. Never throws: a parse failure
// is reported via the returned `error` so callers can decide fail-open vs
// fail-closed themselves.

export interface ReadPayloadResult {
  raw: string;
  payload: Record<string, unknown> | null;
  error: string | null;
}

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (data += chunk));
    stream.on("end", () => resolve(data));
    stream.on("error", (err: Error) => reject(err));
  });
}

export async function readHookPayload(stream?: NodeJS.ReadableStream): Promise<ReadPayloadResult> {
  let raw = "";
  try {
    raw = await readStdin(stream);
  } catch (e) {
    return { raw: "", payload: null, error: `failed to read stdin: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (raw.trim().length === 0) {
    return { raw, payload: null, error: "stdin was empty" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { raw, payload: null, error: "stdin JSON was not an object" };
    }
    return { raw, payload: parsed as Record<string, unknown>, error: null };
  } catch (e) {
    return { raw, payload: null, error: `failed to parse stdin as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}
