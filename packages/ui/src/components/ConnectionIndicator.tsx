import { useEffect, useState } from "react";
import { eventHub, type ConnectionState } from "../api/sse.ts";

const LABELS: Record<ConnectionState, string> = {
  open: "live",
  connecting: "connecting…",
  closed: "offline",
};

export function ConnectionIndicator() {
  const [state, setState] = useState<ConnectionState>("closed");

  useEffect(() => eventHub.subscribeState(setState), []);

  return (
    <span className={`conn-indicator ${state}`} title={`Live updates: ${LABELS[state]}`}>
      <span className="conn-dot" />
      {LABELS[state]}
    </span>
  );
}
