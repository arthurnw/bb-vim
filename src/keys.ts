const SPECIAL: Record<string, string> = {
  Escape: "Esc",
  Enter: "CR",
  Backspace: "BS",
  Tab: "Tab",
  Delete: "Del",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Hyper", "Super"]);

/** Base key from the physical code, so macOS Option-letter combos map to letters. */
function codeBase(e: KeyboardEvent): string | null {
  const { code } = e;
  if (code.startsWith("Key")) {
    const ch = code.slice(3).toLowerCase();
    return e.shiftKey ? ch.toUpperCase() : ch;
  }
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Minus") return e.shiftKey ? "_" : "-";
  if (code in { Backspace: 1, Enter: 1, Tab: 1, Delete: 1, Escape: 1 }) return SPECIAL[code];
  return null;
}

/**
 * Vim notation for a keydown event, or null when the event should always go
 * to bb (Cmd shortcuts, IME composition, bare modifiers).
 */
export function keyName(e: KeyboardEvent): string | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.metaKey || MODIFIER_KEYS.has(e.key)) return null;
  if (e.ctrlKey && e.altKey) return null;
  if (e.altKey) {
    const base = codeBase(e);
    return base ? `<A-${base}>` : null;
  }
  if (e.ctrlKey) {
    const base = codeBase(e);
    if (!base) return null;
    return `<C-${base.length === 1 ? base.toLowerCase() : base}>`;
  }
  const special = SPECIAL[e.key];
  if (special) return e.shiftKey && (special === "CR" || special === "Tab") ? `<S-${special}>` : `<${special}>`;
  if (e.key === " ") return "<Space>";
  if ([...e.key].length === 1) return e.key;
  return null;
}
