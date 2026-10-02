import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getToken, setToken as storeToken, clearToken } from "./token.ts";
import { onUnauthorized } from "../api/authEvents.ts";
import { api, ApiError } from "../api/client.ts";
import { eventHub } from "../api/sse.ts";
import type { DaemonStatus } from "../api/types.ts";

interface AuthState {
  /** null = no token at all; undefined = token present but not yet validated. */
  authenticated: boolean;
  checking: boolean;
  error: string | null;
  status: DaemonStatus | null;
  /** Re-fetch daemon status (kill switch, email health, quiet hours, running tasks). */
  refreshStatus: () => Promise<void>;
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DaemonStatus | null>(null);

  const validate = useCallback(async (): Promise<boolean> => {
    try {
      const { status } = await api.status();
      setStatus(status);
      setAuthenticated(true);
      setError(null);
      eventHub.start();
      return true;
    } catch (err) {
      setAuthenticated(false);
      if (err instanceof ApiError && err.code !== "unauthorized") {
        setError(err.message);
      }
      return false;
    }
  }, []);

  useEffect(() => {
    const existing = getToken();
    if (!existing) {
      setChecking(false);
      return;
    }
    validate().finally(() => setChecking(false));
  }, [validate]);

  useEffect(() => {
    return onUnauthorized(() => {
      clearToken();
      eventHub.stop();
      setAuthenticated(false);
      setError("Session expired or token rejected. Please sign in again.");
    });
  }, []);

  const login = useCallback(
    async (token: string) => {
      storeToken(token);
      setChecking(true);
      const ok = await validate();
      setChecking(false);
      if (!ok) {
        clearToken();
        throw new Error("That token was rejected by the server.");
      }
      eventHub.restart();
    },
    [validate],
  );

  const refreshStatus = useCallback(async () => {
    try {
      setStatus((await api.status()).status);
    } catch {
      // auth failures are handled by onUnauthorized; transient errors keep the last status
    }
  }, []);

  // Status changes underneath us (kill switch toggled elsewhere, auto-trip, sends, quiet hours
  // starting): refresh on the events that imply it, plus a slow poll for time-based changes.
  useEffect(() => {
    if (!authenticated) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refreshStatus(), 300);
    };
    const types = ["settings.changed", "status.changed", "outbox.updated", "task.transition", "run.finished"];
    const unsubs = types.map((type) => eventHub.subscribe(type, soon));
    const poll = setInterval(() => void refreshStatus(), 30_000);
    return () => {
      unsubs.forEach((u) => u());
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [authenticated, refreshStatus]);

  const logout = useCallback(() => {
    clearToken();
    eventHub.stop();
    setAuthenticated(false);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ authenticated, checking, error, status, refreshStatus, login, logout }),
    [authenticated, checking, error, status, refreshStatus, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
