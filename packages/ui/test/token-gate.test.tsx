// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { getToken, clearToken } from "../src/auth/token.ts";
import { ok, fail, routeFetch, installMockEventSource } from "./testUtils.ts";

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("token gate", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearToken();
  });

  it("shows the token form when there is no stored token", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByLabelText(/admin token/i)).toBeTruthy());
    expect(screen.getByText(/admin-token/)).toBeTruthy();
  });

  it("validates the pasted token against /v1/admin/status and shows the app shell on success", async () => {
    installMockEventSource();
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /v1/admin/status": () => ok({ status: { version: "0.0.0", outboundEnabled: false, outboundDisabledReason: "off" } }),
        "GET /v1/admin/outbox": () => ok({ items: [] }),
      }),
    );

    renderApp();
    fireEvent.change(screen.getByLabelText(/admin token/i), { target: { value: "good-token" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole("link", { name: /inbox/i })).toBeTruthy());
    expect(getToken()).toBe("good-token");
  });

  it("shows an error and does not persist the token when the server rejects it", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /v1/admin/status": () => fail("unauthorized", "invalid token", 401),
      }),
    );

    renderApp();
    fireEvent.change(screen.getByLabelText(/admin token/i), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(getToken()).toBeNull();
  });
});
