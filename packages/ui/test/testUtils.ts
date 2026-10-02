import { vi } from "vitest";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function ok<T>(data: T, status = 200): Response {
  return jsonResponse({ ok: true, data }, status);
}

export function fail(code: string, message: string, status = 400): Response {
  return jsonResponse({ ok: false, error: { code, message } }, status);
}

/** A minimal EventSource stand-in: jsdom doesn't implement it, and the app
 * opens one as soon as auth succeeds. Tests just need it to not throw. */
export class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closed = false;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(cb);
  }

  close() {
    this.closed = true;
  }
}

export function installMockEventSource(): void {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
}

/** Builds a `fetch` mock that dispatches on method + path (ignoring query string). */
export function routeFetch(routes: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`No mock route for ${key}`);
    }
    return handler(url, init);
  });
}
