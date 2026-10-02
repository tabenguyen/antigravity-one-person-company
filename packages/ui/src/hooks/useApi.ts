import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.ts";
import { eventHub } from "../api/sse.ts";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Runs `fetcher` on mount and whenever `deps` change; exposes a manual
 * `refresh`. Optionally re-runs whenever one of `refreshOn` SSE event types
 * arrives, so pages like the Inbox stay live without polling.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[], refreshOn: string[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [tick, setTick] = useState(0);

  const run = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (refreshOn.length === 0) return;
    const unsubs = refreshOn.map((type) => eventHub.subscribe(type, () => refresh()));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, ...refreshOn]);

  return { data, loading, error, refresh };
}
