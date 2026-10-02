import { useEffect } from "react";

export interface HotkeyBinding {
  /** Lowercase key, e.g. "a", "j", "arrowdown". Combine with meta/ctrl flags below. */
  key: string;
  handler: (e: KeyboardEvent) => void;
  /** Require Cmd on Mac / Ctrl elsewhere. */
  mod?: boolean;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Registers global keyboard shortcuts; automatically disabled while the
 * event target is a form field (so "a" typed into a subject box never fires
 * Approve). Mod-combos (Cmd/Ctrl+S) still work while typing since they're
 * explicit, deliberate key chords rather than plain letters. */
export function useHotkeys(bindings: HotkeyBinding[], enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      const key = e.key.toLowerCase();
      const modPressed = e.metaKey || e.ctrlKey;
      for (const binding of bindings) {
        if (binding.key !== key) continue;
        if (binding.mod && !modPressed) continue;
        if (!binding.mod && modPressed) continue;
        if (!binding.mod && isTypingTarget(e.target)) continue;
        e.preventDefault();
        binding.handler(e);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, bindings]);
}
