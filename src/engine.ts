import type { EditorHost, EngineOptions, Snapshot } from "./host";
import {
  ATOM,
  CharClass,
  CLOSE_TO_OPEN,
  OPEN_TO_CLOSE,
  charClass,
  clampNormal,
  column,
  findBracketPair,
  findChar,
  findQuotePair,
  firstNonBlank,
  isBlank,
  lastCharOfLine,
  lineCount,
  lineEnd,
  lineIndex,
  lineStart,
  matchPair,
  moveLines,
  paragraphBackward,
  paragraphForward,
  startOfLine,
  toggleCase,
  wordBackward,
  wordEnd,
  wordEndBackward,
  wordForward,
  type Pair,
} from "./text";

export type Mode = "insert" | "normal" | "visual" | "vline" | "search";

export interface Status {
  mode: Mode;
  /** Mode shown to the user; Ctrl-O in Insert shows "(insert)". */
  label: string;
  pending: string;
  searchLine: string | null;
}

interface Register {
  text: string;
  atoms: unknown[];
  linewise: boolean;
}

interface Range {
  from: number;
  to: number;
  linewise: boolean;
}

type Target =
  | { type: "motion"; name: string; arg?: string }
  | { type: "textobj"; inner: boolean; obj: string }
  | { type: "line" };

interface Cmd {
  keys: string[];
  reg: string | null;
  count: number | null;
  kind: "motion" | "op" | "simple";
  name: string;
  arg?: string;
  arg2?: string;
  opCount?: number | null;
  target?: Target;
}

type Parsed = Cmd | "more" | "invalid";

interface Change {
  keys: string[];
  count: number | null;
  inserted: string | null;
}

interface InsertSession {
  snap: Snapshot;
  cursor: number;
  startText: string;
  change: Change | null;
}

interface UndoEntry {
  snap: Snapshot;
  cursor: number;
}

const MAX_COUNT = 9999;

const SIMPLE_MOTIONS = new Set([
  "h", "l", "j", "k", "w", "W", "b", "B", "e", "E", "0", "^", "$", "_", "-", "G", "{", "}",
  "%", ";", ",", "n", "N", "*", "#", "<Left>", "<Right>", "<Up>", "<Down>", "<BS>", "<Home>", "<End>",
]);
const G_MOTIONS = new Set(["g", "e", "E", "j", "k", "h", "l", "_"]);
const FIND_MOTIONS = new Set(["f", "F", "t", "T"]);
const TEXT_OBJECTS = new Set([
  "w", "W", "p", '"', "'", "`", "q", "(", ")", "b", "[", "]", "{", "}", "B", "<", ">", "a", "f",
]);
const VISUAL_CHANGES = new Set([
  "d", "x", "<Del>", "c", "s", "s-then", "D", "X", "C", "S", "~", "u", "U", "J", "gJ", "r", "p", "P",
  ">", "<", "<A-j>", "<A-k>", "<A-h>", "<A-l>", "g~", "gu", "gU", "sa",
]);
const NORMAL_SIMPLE = new Set([
  "i", "a", "I", "A", "o", "O", "v", "V", "x", "X", "S", "D", "C", "Y", "p", "P", "u", "J", "~",
  ".", ">", "<", "+", "<C-r>", "<C-d>", "<C-u>", "<C-e>", "<C-y>", "<A-j>", "<A-k>", "<A-h>",
  "<A-l>", "<Del>",
]);
const VISUAL_SIMPLE = new Set([
  "d", "x", "<Del>", "y", "c", "s", "D", "X", "Y", "C", "S", "~", "u", "U", "J", "p", "P", "o", "O",
  ">", "<", "<A-j>", "<A-k>", "<A-h>", "<A-l>", "v", "V", "<C-d>", "<C-u>", "<C-e>", "<C-y>", "I", "A",
]);

/** Map a typed key to the literal character it stands for in an argument slot. */
function literal(key: string): string | null {
  if (key === "<Space>") return " ";
  if (key === "<Tab>") return "\t";
  return key.length === 1 || [...key].length === 1 ? key : null;
}

function isDigit(k: string | undefined): boolean {
  return k !== undefined && k.length === 1 && k >= "0" && k <= "9";
}

function surroundPair(ch: string): [string, string] {
  switch (ch) {
    case "(":
      return ["( ", " )"];
    case "[":
      return ["[ ", " ]"];
    case "{":
      return ["{ ", " }"];
    case "<":
      return ["< ", " >"];
    case ")":
    case "b":
      return ["(", ")"];
    case "]":
      return ["[", "]"];
    case "}":
    case "B":
      return ["{", "}"];
    case ">":
      return ["<", ">"];
    default:
      return [ch, ch];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** State Vim shares across editors: registers, search, and the last find. */
export class SharedVimState {
  registers = new Map<string, Register>();
  lastMirrored: string | null = null;
  lastFind: { ch: string; forward: boolean; till: boolean } | null = null;
  search: { pattern: string; forward: boolean } | null = null;
  killBuffer = "";
}

export class VimEngine {
  mode: Mode = "insert";
  private pending: string[] = [];
  private oneShotNormal = false;
  private insertPending: string | null = null;
  private anchor = 0;
  private lastVisual: { anchor: number; head: number; mode: "visual" | "vline" } | null = null;
  private goalCol: number | null = null;
  private goalX: number | null = null;
  private hlsearch = false;
  private searchLine: { dir: "/" | "?"; text: string; prev: Mode } | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private session: InsertSession | null = null;
  private lastChange: Change | null = null;
  private replaying = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Called when a deferred action (the `s` timeout) changed state. */
  onAsyncChange: (() => void) | null = null;

  constructor(
    private host: EditorHost,
    public options: EngineOptions,
    private shared = new SharedVimState(),
  ) {
    this.beginInsertSession(null);
  }

  status(): Status {
    const labels: Record<Mode, string> = {
      insert: "INSERT",
      normal: this.oneShotNormal ? "(insert)" : "NORMAL",
      visual: "VISUAL",
      vline: "V-LINE",
      search: this.searchLine?.prev === "visual" ? "VISUAL" : this.searchLine?.prev === "vline" ? "V-LINE" : "NORMAL",
    };
    return {
      mode: this.mode,
      label: labels[this.mode],
      pending: this.pending.map((k) => (k === "<Space>" ? "␣" : k)).join(""),
      searchLine: this.searchLine ? this.searchLine.dir + this.searchLine.text : null,
    };
  }

  /** Where to draw the block cursor. */
  displayCursor(): number {
    if (this.mode === "visual" || this.mode === "vline") return this.visualHead();
    if (this.mode === "search" && this.searchLine && this.searchLine.prev !== "normal") return this.visualHead();
    return this.oneShotNormal ? this.cursor() : this.normalCursor();
  }

  /** The editor gained focus: start typing in Insert mode. */
  focusReset(): void {
    this.clearTimer();
    this.pending = [];
    this.searchLine = null;
    this.oneShotNormal = false;
    if (this.mode !== "insert") {
      this.mode = "insert";
      this.beginInsertSession(null);
    }
  }

  /** The editor lost focus; close an open insert session for undo. */
  blur(): void {
    if (this.mode === "insert") this.commitInsertSession();
  }

  /**
   * Handle one key. Returns false when the key belongs to bb. `queued` marks a
   * key that was intercepted while an async command ran, so printable keys must
   * be typed by the engine itself.
   */
  handleKey(key: string, queued = false): boolean | Promise<boolean> {
    switch (this.mode) {
      case "insert":
        return this.insertKey(key, queued);
      case "search":
        return this.searchKey(key);
      default:
        return this.commandKey(key);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers

  private text(): string {
    return this.host.text();
  }

  private cursor(): number {
    return this.host.selection().head;
  }

  private normalCursor(): number {
    return clampNormal(this.text(), this.cursor());
  }

  private setCursor(pos: number, keepGoal = false): void {
    if (!keepGoal) {
      this.goalCol = null;
      this.goalX = null;
    }
    this.host.setCursor(pos);
  }

  private edit(from: number, to: number, text: string, cursor: number, atoms?: unknown[]): void {
    this.host.replace(from, to, text, atoms ?? this.host.atomsIn(from, to), cursor);
    this.goalCol = null;
    this.goalX = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Undo

  private commit(snap: Snapshot, cursor: number): void {
    if (this.host.isCurrent(snap)) return;
    this.undoStack.push({ snap, cursor });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(count: number): void {
    for (let n = 0; n < count; n++) {
      const entry = this.undoStack.pop();
      if (!entry) break;
      this.redoStack.push({ snap: this.host.snapshot(), cursor: this.normalCursor() });
      this.host.restore(entry.snap, entry.cursor);
    }
    this.setCursor(this.normalCursor());
  }

  private redo(count: number): void {
    for (let n = 0; n < count; n++) {
      const entry = this.redoStack.pop();
      if (!entry) break;
      this.undoStack.push({ snap: this.host.snapshot(), cursor: this.normalCursor() });
      this.host.restore(entry.snap, entry.cursor);
    }
    this.setCursor(this.normalCursor());
  }

  // -------------------------------------------------------------------------
  // Insert mode

  private beginInsertSession(change: Change | null, snap?: Snapshot, cursor?: number): void {
    this.session = {
      snap: snap ?? this.host.snapshot(),
      cursor: cursor ?? this.cursor(),
      startText: this.text(),
      change,
    };
  }

  private commitInsertSession(): string | null {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    const before = s.startText;
    const after = this.text();
    let inserted: string | null = null;
    if (before !== after) {
      let p = 0;
      while (p < before.length && p < after.length && before[p] === after[p]) p++;
      let q = 0;
      while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
      inserted = after.slice(p, after.length - q).split(ATOM).join("");
    }
    this.commit(s.snap, s.cursor);
    if (!this.replaying) {
      if (s.change) this.lastChange = { ...s.change, inserted };
      else if (inserted) this.lastChange = { keys: ["i"], count: null, inserted };
    }
    return inserted;
  }

  private enterInsert(pos: number, change: Change | null, snap?: Snapshot, cursor?: number): void {
    this.setCursor(pos);
    this.mode = "insert";
    this.oneShotNormal = false;
    this.beginInsertSession(change, snap, cursor);
  }

  private exitInsert(): void {
    this.commitInsertSession();
    this.mode = "normal";
    const t = this.text();
    const cur = this.cursor();
    this.setCursor(clampNormal(t, cur > lineStart(t, cur) ? cur - 1 : cur));
  }

  private insertKey(key: string, queued: boolean): boolean {
    if (this.insertPending === "<C-r>") {
      this.insertPending = null;
      const reg = literal(key);
      const r = reg ? this.readRegister(reg) : null;
      if (r) {
        const cur = this.cursor();
        this.edit(cur, cur, r.text, cur + r.text.length, r.atoms);
      }
      return true;
    }
    if (key === "<Esc>" || key === "<C-[>" || key === "<C-c>") {
      this.exitInsert();
      return true;
    }
    if (key === "<C-o>") {
      this.mode = "normal";
      this.oneShotNormal = true;
      return true;
    }
    if (key === "<C-r>") {
      this.insertPending = "<C-r>";
      return true;
    }
    const t = this.text();
    const sel = this.host.selection();
    const cur = sel.head;
    const ls = lineStart(t, cur);
    const le = lineEnd(t, cur);

    if (this.options.readlineKeys) {
      switch (key) {
        case "<C-w>":
        case "<A-BS>": {
          if (cur === ls) {
            if (cur > 0) this.kill(cur - 1, cur, true);
            return true;
          }
          let i = cur;
          while (i > ls && isBlank(t[i - 1])) i--;
          if (i > ls) {
            const c = charClass(t[i - 1]);
            while (i > ls && charClass(t[i - 1]) === c) i--;
          }
          this.kill(i, cur, true);
          return true;
        }
        case "<C-u>":
          if (cur === ls) {
            if (cur > 0) this.kill(cur - 1, cur, true);
          } else this.kill(ls, cur, true);
          return true;
        case "<C-k>":
          if (cur === le) {
            if (le < t.length) this.kill(le, le + 1, false);
          } else this.kill(cur, le, false);
          return true;
        case "<C-q>": {
          const b = wordBackward(t, cur, true);
          this.kill(b > 0 ? b - 1 : 0, cur, true);
          return true;
        }
        case "<A-d>": {
          let i = cur;
          while (i < t.length && charClass(t[i]) !== CharClass.Word) i++;
          while (i < t.length && charClass(t[i]) === CharClass.Word) i++;
          this.kill(cur, i, false);
          return true;
        }
        case "<C-y>":
          if (this.shared.killBuffer) this.edit(cur, cur, this.shared.killBuffer, cur + this.shared.killBuffer.length, []);
          return true;
        case "<C-a>":
          this.setCursor(ls);
          return true;
        case "<C-e>":
          this.setCursor(le);
          return true;
        case "<C-b>":
          this.setCursor(Math.max(0, cur - 1));
          return true;
        case "<C-f>":
          this.setCursor(Math.min(t.length, cur + 1));
          return true;
        case "<C-h>":
          if (cur > 0) this.edit(cur - 1, cur, "", cur - 1);
          return true;
        case "<C-d>":
          if (cur < t.length) this.edit(cur, cur + 1, "", cur);
          return true;
        case "<A-b>": {
          let i = cur;
          while (i > 0 && charClass(t[i - 1]) !== CharClass.Word) i--;
          while (i > 0 && charClass(t[i - 1]) === CharClass.Word) i--;
          this.setCursor(i);
          return true;
        }
        case "<A-f>": {
          let i = cur;
          while (i < t.length && charClass(t[i]) !== CharClass.Word) i++;
          while (i < t.length && charClass(t[i]) === CharClass.Word) i++;
          this.setCursor(i);
          return true;
        }
      }
    }

    switch (key) {
      case "<A-o>": {
        const indent = this.indentOf(t, cur);
        this.edit(le, le, "\n" + indent, le + 1 + indent.length);
        return true;
      }
      case "<A-O>": {
        const indent = this.indentOf(t, cur);
        this.edit(ls, ls, indent + "\n", ls + indent.length);
        return true;
      }
      case "<A-A>":
        this.setCursor(le);
        return true;
      case "<A-I>":
        this.setCursor(firstNonBlank(t, cur));
        return true;
    }

    if (this.options.autoPairs && sel.anchor === sel.head) {
      if (this.autoPair(key, t, cur)) return true;
    }

    if (queued) {
      const ch = literal(key);
      if (ch !== null) {
        const s = Math.min(sel.anchor, sel.head);
        const e = Math.max(sel.anchor, sel.head);
        this.edit(s, e, ch, s + 1, []);
        return true;
      }
      if (key === "<BS>") {
        if (cur > 0) this.edit(cur - 1, cur, "", cur - 1);
        return true;
      }
    }
    return false;
  }

  private kill(from: number, to: number, backward: boolean): void {
    if (from >= to) return;
    this.shared.killBuffer = this.text().slice(from, to).split(ATOM).join("");
    this.edit(from, to, "", backward ? from : from);
  }

  private autoPair(key: string, t: string, cur: number): boolean {
    const next = t[cur];
    const prev = t[cur - 1];
    if (key in OPEN_TO_CLOSE && key !== "<") {
      this.edit(cur, cur, key + OPEN_TO_CLOSE[key], cur + 1, []);
      return true;
    }
    if (key in CLOSE_TO_OPEN && key !== ">" && next === key) {
      this.setCursor(cur + 1);
      return true;
    }
    if (key === '"' || key === "`") {
      if (next === key) {
        this.setCursor(cur + 1);
        return true;
      }
      if (prev !== undefined && charClass(prev) === CharClass.Word) return false;
      this.edit(cur, cur, key + key, cur + 1, []);
      return true;
    }
    if (key === "<BS>" && prev !== undefined && next !== undefined) {
      if ((OPEN_TO_CLOSE[prev] === next && prev !== "<") || ((prev === '"' || prev === "`") && next === prev)) {
        this.edit(cur - 1, cur + 1, "", cur - 1);
        return true;
      }
    }
    return false;
  }

  private indentOf(t: string, pos: number): string {
    const s = lineStart(t, pos);
    let i = s;
    while (isBlank(t[i])) i++;
    return t.slice(s, i);
  }

  // -------------------------------------------------------------------------
  // Search command line

  private searchKey(key: string): boolean {
    const line = this.searchLine!;
    const back = () => {
      this.mode = line.prev;
      this.searchLine = null;
    };
    if (key === "<Esc>" || key === "<C-[>" || key === "<C-c>") {
      back();
      return true;
    }
    if (key === "<CR>") {
      back();
      if (line.text) this.shared.search = { pattern: line.text, forward: line.dir === "/" };
      if (this.shared.search) this.searchJump(this.shared.search.forward, 1, true);
      return true;
    }
    if (key === "<BS>" || key === "<C-h>") {
      if (!line.text) back();
      else line.text = line.text.slice(0, -1);
      return true;
    }
    if (key === "<C-u>") {
      line.text = "";
      return true;
    }
    if (key === "<C-w>") {
      line.text = line.text.replace(/\s*\S+\s*$/, "");
      return true;
    }
    const ch = literal(key);
    if (ch !== null) line.text += ch;
    return true;
  }

  private searchRegex(pattern: string): RegExp | null {
    const flags = /[A-Z]/.test(pattern.replace(/\\./g, "")) ? "g" : "gi";
    const source = pattern.replace(/\\[<>]/g, "\\b");
    try {
      return new RegExp(source, flags);
    } catch {
      try {
        return new RegExp(escapeRegExp(pattern), flags);
      } catch {
        return null;
      }
    }
  }

  private matches(): { from: number; to: number }[] {
    if (!this.shared.search) return [];
    const re = this.searchRegex(this.shared.search.pattern);
    if (!re) return [];
    const t = this.text();
    const out: { from: number; to: number }[] = [];
    for (const m of t.matchAll(re)) {
      if (m[0].length === 0) continue;
      out.push({ from: m.index!, to: m.index! + m[0].length });
      if (out.length > 2000) break;
    }
    return out;
  }

  private searchTarget(forward: boolean, count: number, from: number): number | null {
    const ms = this.matches();
    if (ms.length === 0) return null;
    let pos = from;
    for (let n = 0; n < count; n++) {
      const m = forward ? (ms.find((x) => x.from > pos) ?? ms[0]) : ([...ms].reverse().find((x) => x.from < pos) ?? ms[ms.length - 1]);
      pos = m.from;
    }
    return pos;
  }

  private searchJump(forward: boolean, count: number, move: boolean): number | null {
    this.hlsearch = true;
    this.refreshHighlight();
    const target = this.searchTarget(forward, count, this.cursor());
    if (target !== null && move) this.moveTo(target);
    return target;
  }

  private moveTo(pos: number): void {
    if (this.mode === "visual" || this.mode === "vline") {
      this.setCursor(pos);
      this.showVisual(pos);
    } else this.setCursor(clampNormal(this.text(), pos));
  }

  refreshHighlight(): void {
    this.host.setSearchHighlight(this.hlsearch && this.shared.search ? this.matches() : null);
  }

  private wordUnderCursor(): { from: number; to: number } | null {
    const t = this.text();
    let i = this.normalCursor();
    const e = lineEnd(t, i);
    while (i < e && charClass(t[i]) !== CharClass.Word) i++;
    if (i >= e) return null;
    let s = i;
    while (s > 0 && charClass(t[s - 1]) === CharClass.Word) s--;
    let f = i;
    while (f < t.length && charClass(t[f]) === CharClass.Word) f++;
    return { from: s, to: f };
  }

  private starSearch(forward: boolean, move: boolean, count: number): number | null {
    const w = this.wordUnderCursor();
    if (!w) return null;
    const word = this.text().slice(w.from, w.to);
    this.shared.search = { pattern: `\\<${escapeRegExp(word)}\\>`, forward };
    return this.searchJump(forward, count, move);
  }

  // -------------------------------------------------------------------------
  // Command parsing (Normal and Visual)

  private parse(keys: string[], visual: boolean): Parsed {
    let i = 0;
    let reg: string | null = null;
    const at = (n: number) => keys[n];
    if (at(i) === '"') {
      if (at(i + 1) === undefined) return "more";
      reg = literal(at(i + 1)!);
      if (reg === null) return "invalid";
      i += 2;
    }
    let count: number | null = null;
    while (isDigit(at(i)) && (count !== null || at(i) !== "0")) {
      count = Math.min(MAX_COUNT, (count ?? 0) * 10 + Number(at(i)));
      i++;
    }
    const key = at(i);
    if (key === undefined) return "more";
    const done = (kind: Cmd["kind"], name: string, extra: Partial<Cmd> = {}): Cmd => ({
      keys,
      reg,
      count,
      kind,
      name,
      ...extra,
    });

    // Operators. In Visual mode they act on the selection immediately.
    let op: string | null = null;
    let j = i;
    if (key === "d" || key === "c" || key === "y") {
      op = key;
      j = i + 1;
    } else if (key === "g") {
      const n = at(i + 1);
      if (n === undefined) return "more";
      if (n === "~" || n === "u" || n === "U") {
        op = "g" + n;
        j = i + 2;
      } else if (n === "v" && !visual) return done("simple", "gv");
      else if (n === "J") return done("simple", "gJ");
    } else if (key === "<Space>") {
      const n = at(i + 1);
      if (n === undefined) return "more";
      if (n !== "y") return "invalid";
      op = "leader-y";
      j = i + 2;
    } else if (key === "s") {
      const n = at(i + 1);
      if (n === undefined) return "more";
      if (n === "a") {
        op = "sa";
        j = i + 2;
      } else if (n === "d" && !visual) {
        const c = at(i + 2);
        if (c === undefined) return "more";
        return done("simple", "sd", { arg: literal(c) ?? undefined });
      } else if (n === "r" && !visual) {
        const a = at(i + 2);
        const b = at(i + 3);
        if (a === undefined || b === undefined) return "more";
        return done("simple", "sr", { arg: literal(a) ?? undefined, arg2: literal(b) ?? undefined });
      } else {
        return done("simple", "s-then", { arg: n });
      }
    }

    if (op !== null && visual) {
      if (op === "sa") {
        const c = at(j);
        if (c === undefined) return "more";
        return done("op", "sa", { arg: literal(c) ?? undefined });
      }
      if (op === "d" || op === "c" || op === "y") return done("simple", op);
      return done("op", op);
    }

    if (op !== null) {
      let opCount: number | null = null;
      while (isDigit(at(j)) && (opCount !== null || at(j) !== "0")) {
        opCount = Math.min(MAX_COUNT, (opCount ?? 0) * 10 + Number(at(j)));
        j++;
      }
      const k = at(j);
      if (k === undefined) return "more";
      let target: Target | null = null;
      let after = j + 1;
      const opChar = op === "leader-y" ? "y" : op.length === 2 ? op[1] : op;
      if (k === opChar && op !== "sa") target = { type: "line" };
      else if (op.startsWith("g") && k === "g" && at(j + 1) === op[1]) {
        target = { type: "line" };
        after = j + 2;
      } else if (k === "i" || k === "a") {
        const o = at(j + 1);
        if (o === undefined) return "more";
        if (!TEXT_OBJECTS.has(o)) return "invalid";
        target = { type: "textobj", inner: k === "i", obj: o };
        after = j + 2;
      } else {
        const m = this.parseMotion(keys, j);
        if (m === "more") return "more";
        if (m === null) return "invalid";
        target = { type: "motion", name: m.name, arg: m.arg };
        after = j + m.len;
      }
      let arg: string | undefined;
      if (op === "sa") {
        const c = at(after);
        if (c === undefined) return "more";
        arg = literal(c) ?? undefined;
      }
      return done("op", op, { opCount, target, arg });
    }

    if (key === "r") {
      const c = at(i + 1);
      if (c === undefined) return "more";
      return done("simple", "r", { arg: c === "<CR>" ? "\n" : (literal(c) ?? undefined) });
    }

    if (visual) {
      if (key === "i" || key === "a") {
        const o = at(i + 1);
        if (o === undefined) return "more";
        if (TEXT_OBJECTS.has(o)) return done("simple", "textobj", { arg: o, arg2: key });
        return "invalid";
      }
      if (VISUAL_SIMPLE.has(key)) return done("simple", key);
    } else if (NORMAL_SIMPLE.has(key)) {
      return done("simple", key);
    }

    const m = this.parseMotion(keys, i);
    if (m === "more") return "more";
    if (m === null) return "invalid";
    return done("motion", m.name, { arg: m.arg });
  }

  private parseMotion(keys: string[], i: number): { name: string; arg?: string; len: number } | "more" | null {
    const k = keys[i];
    if (k === undefined) return "more";
    if (SIMPLE_MOTIONS.has(k)) return { name: k, len: 1 };
    if (k === "g") {
      const n = keys[i + 1];
      if (n === undefined) return "more";
      return G_MOTIONS.has(n) ? { name: "g" + n, len: 2 } : null;
    }
    if (FIND_MOTIONS.has(k)) {
      const n = keys[i + 1];
      if (n === undefined) return "more";
      const ch = literal(n);
      return ch === null ? null : { name: k, arg: ch, len: 2 };
    }
    return null;
  }

  private commandKey(key: string): boolean | Promise<boolean> {
    const visual = this.mode === "visual" || this.mode === "vline";
    if (key === "<Esc>" || key === "<C-[>" || key === "<C-c>") {
      this.clearTimer();
      if (this.pending.length > 0) {
        this.pending = [];
        return true;
      }
      if (visual) {
        this.exitVisual();
        return true;
      }
      if (this.oneShotNormal) {
        this.oneShotNormal = false;
        this.mode = "insert";
        return true;
      }
      if (this.hlsearch) {
        this.hlsearch = false;
        this.refreshHighlight();
        return true;
      }
      return key === "<C-[>";
    }
    if (this.pending.length === 0) {
      if (key === "<CR>" || key === "<S-CR>" || key === "<Tab>" || key === "<S-Tab>") return false;
      if ((key === "/" || key === "?") && !this.oneShotNormal) {
        this.searchLine = { dir: key, text: "", prev: this.mode };
        this.mode = "search";
        return true;
      }
    }
    this.clearTimer();
    this.pending.push(key);
    const parsed = this.parse(this.pending, visual);
    if (parsed === "more") {
      if (this.pending[this.pending.length - 1] === "s" && this.pending.filter((k) => k === "s").length === 1) {
        this.armSurroundTimeout(visual);
      }
      return true;
    }
    this.pending = [];
    if (parsed === "invalid") {
      // Unknown Ctrl/Alt chords belong to bb; plain keys are swallowed.
      return !(key.startsWith("<C-") || key.startsWith("<A-") || key.startsWith("<M-"));
    }
    const result = visual ? this.execVisual(parsed) : this.execNormal(parsed);
    const finish = () => {
      if (this.oneShotNormal && this.mode === "normal" && this.pending.length === 0) {
        this.oneShotNormal = false;
        this.mode = "insert";
      }
      return true;
    };
    if (result instanceof Promise) return result.then(finish);
    return finish();
  }

  private armSurroundTimeout(visual: boolean): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending[this.pending.length - 1] !== "s") return;
      const keys = this.pending;
      this.pending = [];
      const cmd = this.parse([...keys.slice(0, -1), "s", "<substitute>"], visual);
      if (cmd !== "more" && cmd !== "invalid") {
        if (visual) this.execVisual(cmd);
        else this.execNormal(cmd);
      }
      this.onAsyncChange?.();
    }, this.options.surroundTimeoutMs);
  }

  /** Run a deferred `s` immediately (tests). */
  flushTimers(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    const visual = this.mode === "visual" || this.mode === "vline";
    const keys = this.pending;
    this.pending = [];
    const cmd = this.parse([...keys.slice(0, -1), "s", "<substitute>"], visual);
    if (cmd !== "more" && cmd !== "invalid") {
      if (visual) this.execVisual(cmd);
      else this.execNormal(cmd);
    }
  }

  // -------------------------------------------------------------------------
  // Motions

  private motion(
    name: string,
    arg: string | undefined,
    count: number | null,
    cur: number,
    forOp: string | null,
  ): { pos: number; kind: "excl" | "incl" | "line" } | null {
    const t = this.text();
    const n = count ?? 1;
    const ls = lineStart(t, cur);
    const visual = this.mode === "visual" || this.mode === "vline";
    switch (name) {
      case "h":
      case "<Left>":
      case "<BS>":
        return { pos: Math.max(ls, cur - n), kind: "excl" };
      case "l":
      case "<Right>": {
        const limit = forOp || visual ? lineEnd(t, cur) : lastCharOfLine(t, cur);
        return { pos: Math.min(limit, cur + n), kind: "excl" };
      }
      case "j":
      case "k":
      case "<Down>":
      case "<Up>":
      case "gj":
      case "gk": {
        const dir = name === "j" || name === "<Down>" || name === "gj" ? 1 : -1;
        const display = name === "gj" || name === "gk" || (count === null && !forOp);
        if (display) {
          let pos = cur;
          let moved = false;
          for (let k = 0; k < n; k++) {
            const r = this.host.moveDisplayLine(pos, dir, this.goalX);
            if (!r) break;
            moved = true;
            this.goalX = r.x;
            pos = r.pos;
          }
          if (moved) return { pos: visual ? pos : clampNormal(this.text(), pos), kind: "excl" };
        }
        if (this.goalCol === null) this.goalCol = column(t, cur);
        return { pos: moveLines(t, cur, dir * n, this.goalCol), kind: "line" };
      }
      case "0":
      case "<Home>":
        return { pos: ls, kind: "excl" };
      case "^":
        return { pos: firstNonBlank(t, cur), kind: "excl" };
      case "gh":
        return { pos: firstNonBlank(t, cur), kind: forOp ? "incl" : "excl" };
      case "$":
      case "<End>":
      case "gl": {
        const line = startOfLine(t, lineIndex(t, cur) + n - 1);
        const end = lineEnd(t, line);
        if (forOp || visual) return { pos: end > line ? end - 1 : line, kind: "incl" };
        return { pos: lastCharOfLine(t, line), kind: "incl" };
      }
      case "g_": {
        const line = startOfLine(t, lineIndex(t, cur) + n - 1);
        let e = lineEnd(t, line) - 1;
        while (e > line && isBlank(t[e])) e--;
        return { pos: Math.max(line, e), kind: "incl" };
      }
      case "_":
        return { pos: firstNonBlank(t, startOfLine(t, lineIndex(t, cur) + n - 1)), kind: "line" };
      case "-":
        return { pos: firstNonBlank(t, startOfLine(t, Math.max(0, lineIndex(t, cur) - n))), kind: "line" };
      case "G":
        return {
          pos: firstNonBlank(t, startOfLine(t, count === null ? lineCount(t) - 1 : count - 1)),
          kind: "line",
        };
      case "gg":
        return { pos: firstNonBlank(t, startOfLine(t, count === null ? 0 : count - 1)), kind: "line" };
      case "w":
      case "W": {
        const big = name === "W";
        let pos = cur;
        for (let k = 0; k < n; k++) {
          const next = wordForward(t, pos, big);
          if (forOp && k === n - 1 && lineIndex(t, next) > lineIndex(t, pos)) {
            // dw on the last word of a line stops at the line end.
            const e = lineEnd(t, pos);
            pos = e > cur ? e : next;
            break;
          }
          pos = next;
        }
        return { pos, kind: "excl" };
      }
      case "b":
      case "B": {
        let pos = cur;
        for (let k = 0; k < n; k++) pos = wordBackward(t, pos, name === "B");
        return { pos, kind: "excl" };
      }
      case "e":
      case "E": {
        let pos = cur;
        for (let k = 0; k < n; k++) pos = wordEnd(t, pos, name === "E");
        return { pos, kind: "incl" };
      }
      case "ge":
      case "gE": {
        let pos = cur;
        for (let k = 0; k < n; k++) pos = wordEndBackward(t, pos, name === "gE");
        return { pos, kind: "incl" };
      }
      case "}": {
        let pos = cur;
        for (let k = 0; k < n; k++) pos = paragraphForward(t, pos);
        return { pos: forOp || visual ? pos : clampNormal(t, pos), kind: "excl" };
      }
      case "{": {
        let pos = cur;
        for (let k = 0; k < n; k++) pos = paragraphBackward(t, pos);
        return { pos, kind: "excl" };
      }
      case "%": {
        const p = matchPair(t, cur);
        return p === null ? null : { pos: p, kind: "incl" };
      }
      case "f":
      case "F":
      case "t":
      case "T": {
        if (!arg) return null;
        const forward = name === "f" || name === "t";
        const till = name === "t" || name === "T";
        if (!this.replaying || !this.shared.lastFind) this.shared.lastFind = { ch: arg, forward, till };
        const p = findChar(t, cur, arg, forward, till, n);
        return p === null ? null : { pos: p, kind: forward ? "incl" : "excl" };
      }
      case ";":
      case ",": {
        const f = this.shared.lastFind;
        if (!f) return null;
        const forward = name === ";" ? f.forward : !f.forward;
        const p = findChar(t, cur, f.ch, forward, f.till, n, true);
        return p === null ? null : { pos: p, kind: forward ? "incl" : "excl" };
      }
      case "n":
      case "N": {
        if (!this.shared.search) return null;
        const forward = name === "n" ? this.shared.search.forward : !this.shared.search.forward;
        this.hlsearch = true;
        this.refreshHighlight();
        const p = this.searchTarget(forward, n, cur);
        return p === null ? null : { pos: p, kind: "excl" };
      }
      case "*":
      case "#": {
        const p = this.starSearch(name === "*", false, n);
        return p === null ? null : { pos: p, kind: "excl" };
      }
    }
    return null;
  }

  private motionRange(target: Target, count: number | null, cur: number, op: string): Range | null {
    const t = this.text();
    if (target.type === "line") {
      const first = lineStart(t, cur);
      const last = startOfLine(t, lineIndex(t, cur) + (count ?? 1) - 1);
      return { from: first, to: lineEnd(t, last), linewise: true };
    }
    if (target.type === "textobj") return this.textObject(target.obj, target.inner, count ?? 1, cur, cur);
    let name = target.name;
    // cw on a non-blank behaves like ce.
    if (op === "c" && (name === "w" || name === "W") && charClass(t[cur]) !== CharClass.Space) {
      name = name === "w" ? "e" : "E";
      let pos = cur;
      for (let k = 0; k < (count ?? 1); k++) {
        pos = k === 0 && charClass(t[cur + 1], name === "E") !== charClass(t[cur], name === "E") ? cur : wordEnd(t, pos, name === "E");
      }
      return { from: cur, to: Math.min(t.length, pos + 1), linewise: false };
    }
    const m = this.motion(name, target.arg, count, cur, op);
    if (!m) return null;
    const from = Math.min(cur, m.pos);
    const max = Math.max(cur, m.pos);
    if (m.kind === "line") {
      return { from: lineStart(t, from), to: lineEnd(t, max), linewise: true };
    }
    if (m.kind === "incl") {
      const to = max < t.length && t[max] !== "\n" ? max + 1 : max;
      return { from, to, linewise: false };
    }
    return { from, to: max, linewise: false };
  }

  // -------------------------------------------------------------------------
  // Text objects

  private textObject(obj: string, inner: boolean, count: number, a: number, b: number): Range | null {
    const t = this.text();
    const cur = b;
    switch (obj) {
      case "w":
      case "W":
        return this.wordObject(t, cur, count, !inner, obj === "W");
      case "p":
        return this.paragraphObject(t, cur, !inner);
      case '"':
      case "'":
      case "`":
      case "q": {
        const p = findQuotePair(t, cur, obj === "q" ? ['"', "'", "`"] : [obj]);
        return p && this.pairRange(p, inner);
      }
      case "(":
      case ")":
      case "[":
      case "]":
      case "{":
      case "}":
      case "B":
      case "<":
      case ">":
      case "b": {
        const opens =
          obj === "b" ? ["(", "[", "{"] : obj === "B" ? ["{"] : [obj in OPEN_TO_CLOSE ? obj : CLOSE_TO_OPEN[obj]];
        let p = findBracketPair(t, cur, opens);
        // Repeating `ib` in Visual mode on an already-selected inner range grows it.
        if (p && a !== b && Math.min(a, b) === p.open + 1 && Math.max(a, b) === p.close - 1) {
          p = findBracketPair(t, p.open - 1, opens) ?? p;
        }
        return p && this.pairRange(p, inner);
      }
      case "a":
        return this.argumentObject(t, cur, inner);
      case "f":
        return this.callObject(t, cur, inner);
    }
    return null;
  }

  private pairRange(p: Pair, inner: boolean): Range {
    return inner ? { from: p.open + 1, to: p.close, linewise: false } : { from: p.open, to: p.close + 1, linewise: false };
  }

  private wordObject(t: string, pos: number, count: number, around: boolean, big: boolean): Range {
    const ls = lineStart(t, pos);
    const le = lineEnd(t, pos);
    if (ls === le) return { from: pos, to: pos, linewise: false };
    const cls = (i: number) => charClass(t[i], big);
    const runEnd = (i: number) => {
      const c = cls(i);
      while (i < le && cls(i) === c) i++;
      return i;
    };
    let start = pos;
    const c0 = cls(pos);
    while (start > ls && cls(start - 1) === c0) start--;
    let end = runEnd(pos);
    for (let k = 1; k < count && end < le; k++) end = runEnd(end);
    if (around) {
      if (c0 !== CharClass.Space) {
        if (end < le && cls(end) === CharClass.Space) end = runEnd(end);
        else while (start > ls && cls(start - 1) === CharClass.Space) start--;
      } else if (end < le) end = runEnd(end);
    }
    return { from: start, to: end, linewise: false };
  }

  private paragraphObject(t: string, pos: number, around: boolean): Range {
    const blank = (s: number) => /^\s*$/.test(t.slice(s, lineEnd(t, s)));
    const startBlank = blank(lineStart(t, pos));
    let from = lineStart(t, pos);
    while (from > 0 && blank(lineStart(t, from - 1)) === startBlank) from = lineStart(t, from - 1);
    let last = lineStart(t, pos);
    const nextLine = (s: number) => {
      const e = lineEnd(t, s);
      return e < t.length ? e + 1 : -1;
    };
    for (let s = nextLine(last); s !== -1 && blank(s) === startBlank; s = nextLine(s)) last = s;
    if (around) {
      let s = nextLine(last);
      let extended = false;
      for (; s !== -1 && blank(s) !== startBlank; s = nextLine(s)) {
        last = s;
        extended = true;
      }
      if (!extended) {
        while (from > 0 && blank(lineStart(t, from - 1)) !== startBlank) from = lineStart(t, from - 1);
      }
    }
    return { from, to: lineEnd(t, last), linewise: true };
  }

  private argumentObject(t: string, pos: number, inner: boolean): Range | null {
    const p = findBracketPair(t, pos, ["(", "[", "{"]);
    if (!p) return null;
    const parts: { from: number; to: number }[] = [];
    let depth = 0;
    let quote: string | null = null;
    let segStart = p.open + 1;
    for (let i = p.open + 1; i < p.close; i++) {
      const ch = t[i];
      if (quote) {
        if (ch === quote && t[i - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch in OPEN_TO_CLOSE) depth++;
      else if (ch in CLOSE_TO_OPEN) depth--;
      else if (ch === "," && depth === 0) {
        parts.push({ from: segStart, to: i });
        segStart = i + 1;
      }
    }
    parts.push({ from: segStart, to: p.close });
    const idx = Math.max(0, parts.findIndex((s) => pos >= s.from && pos <= s.to));
    const seg = parts[idx];
    let from = seg.from;
    let to = seg.to;
    while (from < to && /\s/.test(t[from])) from++;
    while (to > from && /\s/.test(t[to - 1])) to--;
    if (inner) return { from, to, linewise: false };
    if (idx < parts.length - 1) {
      to = parts[idx + 1].from;
      while (to < p.close && /\s/.test(t[to])) to++;
    } else if (idx > 0) {
      from = parts[idx - 1].to;
    }
    return { from, to, linewise: false };
  }

  private callObject(t: string, pos: number, inner: boolean): Range | null {
    let p = findBracketPair(t, pos, ["("]);
    while (p) {
      let s = p.open;
      while (s > 0 && /[\p{L}\p{N}_.]/u.test(t[s - 1])) s--;
      if (s < p.open) {
        return inner ? { from: p.open + 1, to: p.close, linewise: false } : { from: s, to: p.close + 1, linewise: false };
      }
      if (p.open === 0) return null;
      const outer = findBracketPair(t, p.open - 1, ["("]);
      p = outer && outer.open < p.open && outer.close > p.close ? outer : null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Registers

  private writeRegister(reg: string | null, r: Register, kind: "yank" | "delete"): void {
    if (reg === "_") return;
    const plain = r.text.split(ATOM).length > 1 ? this.plainText(r) : r.text;
    if (reg === "+" || reg === "*") {
      this.shared.registers.set("+", r);
      this.shared.registers.set('"', r);
      this.host.writeClipboard(plain);
      this.shared.lastMirrored = plain;
      return;
    }
    if (reg && /^[a-zA-Z]$/.test(reg)) {
      const lower = reg.toLowerCase();
      const prev = this.shared.registers.get(lower);
      const next =
        reg !== lower && prev
          ? { text: prev.text + r.text, atoms: [...prev.atoms, ...r.atoms], linewise: prev.linewise || r.linewise }
          : r;
      this.shared.registers.set(lower, next);
      this.shared.registers.set('"', next);
      this.shared.lastMirrored = null;
      return;
    }
    this.shared.registers.set('"', r);
    if (kind === "yank") this.shared.registers.set("0", r);
    const mirror = this.options.clipboard === "all" || (this.options.clipboard === "yank" && kind === "yank");
    if (mirror) {
      this.host.writeClipboard(plain);
      this.shared.lastMirrored = plain;
    } else this.shared.lastMirrored = null;
  }

  private plainText(r: Register): string {
    let k = 0;
    return r.text.replace(new RegExp(ATOM, "g"), () => {
      const atom = r.atoms[k++];
      return atom === undefined ? "" : this.host.atomText(atom);
    });
  }

  private readRegister(reg: string): Register | null {
    if (reg === "+" || reg === "*") return this.shared.registers.get("+") ?? null;
    return this.shared.registers.get(reg.toLowerCase()) ?? null;
  }

  private async resolvePut(reg: string | null): Promise<Register | null> {
    if (this.replaying) return this.readRegister(reg ?? '"');
    const fromClipboard = (text: string | null): Register | null =>
      text ? { text, atoms: [], linewise: text.endsWith("\n") } : null;
    if (reg === "+" || reg === "*") {
      const clip = await this.host.readClipboard();
      if (clip !== null && clip === this.shared.lastMirrored) return this.readRegister("+") ?? fromClipboard(clip);
      return fromClipboard(clip) ?? this.readRegister("+");
    }
    if (reg !== null && reg !== '"') return this.readRegister(reg);
    const unnamed = this.shared.registers.get('"') ?? null;
    if (unnamed && this.shared.lastMirrored === null) return unnamed;
    const clip = await this.host.readClipboard();
    if (clip !== null && unnamed && clip === this.shared.lastMirrored) return unnamed;
    return fromClipboard(clip) ?? unnamed;
  }

  private captureRange(r: Range): Register {
    const t = this.text();
    return {
      text: t.slice(r.from, r.to) + (r.linewise ? "\n" : ""),
      atoms: this.host.atomsIn(r.from, r.to),
      linewise: r.linewise,
    };
  }

  // -------------------------------------------------------------------------
  // Editing primitives

  private deleteRange(r: Range): number {
    const t = this.text();
    if (!r.linewise) {
      this.edit(r.from, r.to, "", r.from);
      this.setCursor(clampNormal(this.text(), r.from));
      return r.from;
    }
    const line = lineIndex(t, r.from);
    let { from, to } = r;
    if (to < t.length) to += 1;
    else if (from > 0) from -= 1;
    this.edit(from, to, "", from);
    const nt = this.text();
    const pos = firstNonBlank(nt, startOfLine(nt, Math.min(line, lineCount(nt) - 1)));
    this.setCursor(clampNormal(nt, pos));
    return pos;
  }

  private transformRange(r: Range, fn: (s: string) => string): void {
    const t = this.text();
    const before = t.slice(r.from, r.to);
    const after = fn(before);
    if (after !== before) this.edit(r.from, r.to, after, r.from);
    else this.setCursor(r.from);
  }

  private indentLines(first: number, last: number, dir: 1 | -1, times: number): void {
    const t = this.text();
    const from = lineStart(t, first);
    const to = lineEnd(t, last);
    const unit = this.options.indent;
    const lines = t.slice(from, to).split("\n").map((line) => {
      if (line.length === 0) return line;
      if (dir > 0) return unit.repeat(times) + line;
      let out = line;
      for (let k = 0; k < times; k++) {
        if (out.startsWith(unit)) out = out.slice(unit.length);
        else if (out.startsWith("\t")) out = out.slice(1);
        else out = out.replace(/^[ \t]+/, "");
      }
      return out;
    });
    const next = lines.join("\n");
    if (next === t.slice(from, to)) return;
    this.edit(from, to, next, from);
    this.setCursor(firstNonBlank(this.text(), from));
  }

  private joinLines(cur: number, count: number, spaces: boolean): void {
    const t = this.text();
    const first = lineIndex(t, cur);
    const joins = Math.max(1, count - 1);
    if (first + 1 >= lineCount(t)) return;
    const from = lineStart(t, cur);
    const lastLine = Math.min(lineCount(t) - 1, first + joins);
    const to = lineEnd(t, startOfLine(t, lastLine));
    const lines = t.slice(from, to).split("\n");
    let out = lines[0];
    let joinAt = 0;
    for (let k = 1; k < lines.length; k++) {
      let next = lines[k];
      if (spaces) {
        next = next.replace(/^[ \t]+/, "");
        out = out.replace(/[ \t]+$/, "");
        joinAt = out.length;
        if (next.length > 0 && out.length > 0 && !next.startsWith(")")) {
          out += " ";
        }
      } else joinAt = out.length;
      out += next;
    }
    this.edit(from, to, out, from + joinAt);
  }

  private moveLinesBy(first: number, last: number, delta: number): { first: number; last: number } | null {
    const t = this.text();
    const lines = t.split("\n");
    const a = lineIndex(t, first);
    const b = lineIndex(t, last);
    const target = Math.max(0, Math.min(lines.length - (b - a + 1), a + delta));
    if (target === a) return null;
    const block = lines.splice(a, b - a + 1);
    lines.splice(target, 0, ...block);
    const lo = Math.min(a, target);
    const hi = Math.max(b, target + (b - a));
    const from = startOfLine(t, lo);
    const to = lineEnd(t, startOfLine(t, hi));
    const replaced = lines.slice(lo, hi + 1).join("\n");
    const offsetInLine = column(t, this.cursor());
    this.edit(from, to, replaced, from, this.reorderAtoms(t, from, to, replaced));
    const nt = this.text();
    const newFirst = startOfLine(nt, target);
    const newLast = startOfLine(nt, target + (b - a));
    this.setCursor(Math.min(newFirst + offsetInLine, lastCharOfLine(nt, newFirst)));
    return { first: newFirst, last: newLast };
  }

  /** Atoms in [from, to) reordered to follow lines that were moved. */
  private reorderAtoms(t: string, from: number, to: number, replaced: string): unknown[] {
    const atoms = this.host.atomsIn(from, to);
    if (atoms.length === 0) return atoms;
    const lines = t.slice(from, to).split("\n");
    const perLine = new Map<string, unknown[][]>();
    let k = 0;
    for (const line of lines) {
      const n = line.split(ATOM).length - 1;
      const list = perLine.get(line) ?? [];
      list.push(atoms.slice(k, k + n));
      perLine.set(line, list);
      k += n;
    }
    return replaced.split("\n").flatMap((line) => perLine.get(line)?.shift() ?? []);
  }

  private async put(reg: string | null, count: number, before: boolean, cur: number): Promise<void> {
    const r = await this.resolvePut(reg);
    if (!r || r.text.length === 0) return;
    const snap = this.host.snapshot();
    const t = this.text();
    const n = Math.max(1, count);
    if (r.linewise) {
      const body = r.text.endsWith("\n") ? r.text.slice(0, -1) : r.text;
      const block = Array(n).fill(body).join("\n");
      const atoms = Array(n).fill(r.atoms).flat();
      if (before) {
        const s = lineStart(t, cur);
        this.edit(s, s, block + "\n", s, atoms);
        this.setCursor(firstNonBlank(this.text(), s));
      } else {
        const e = lineEnd(t, cur);
        this.edit(e, e, "\n" + block, e + 1, atoms);
        this.setCursor(firstNonBlank(this.text(), e + 1));
      }
    } else {
      const block = r.text.repeat(n);
      const atoms = Array(n).fill(r.atoms).flat();
      const at = before || t.length === 0 || t[cur] === "\n" || cur >= t.length ? cur : cur + 1;
      this.edit(at, at, block, Math.max(at, at + block.length - 1), atoms);
    }
    this.commit(snap, cur);
  }

  // -------------------------------------------------------------------------
  // Surround (mini.surround)

  private findSurround(t: string, cur: number, ch: string): Pair | null {
    if (ch === "b" || ch in OPEN_TO_CLOSE || ch in CLOSE_TO_OPEN) {
      const opens = ch === "b" ? ["(", "[", "{"] : [ch in OPEN_TO_CLOSE ? ch : CLOSE_TO_OPEN[ch]];
      return findBracketPair(t, cur, opens);
    }
    if (ch === "q") return findQuotePair(t, cur, ['"', "'", "`"]);
    return findQuotePair(t, cur, [ch]);
  }

  private surroundDelete(cur: number, ch: string, replacement?: string): void {
    const t = this.text();
    const p = this.findSurround(t, cur, ch);
    if (!p) return;
    let innerFrom = p.open + 1;
    let innerTo = p.close;
    if (ch in OPEN_TO_CLOSE) {
      while (innerFrom < innerTo && isBlank(t[innerFrom])) innerFrom++;
      while (innerTo > innerFrom && isBlank(t[innerTo - 1])) innerTo--;
    }
    const inner = t.slice(innerFrom, innerTo);
    const [l, r] = replacement === undefined ? ["", ""] : surroundPair(replacement);
    this.edit(p.open, p.close + 1, l + inner + r, p.open, this.host.atomsIn(innerFrom, innerTo));
  }

  private surroundAdd(r: Range, ch: string): void {
    const t = this.text();
    const [l, rr] = surroundPair(ch);
    let { from, to } = r;
    if (r.linewise) {
      from = firstNonBlank(t, from);
    }
    const inner = t.slice(from, to);
    this.edit(from, to, l + inner + rr, from);
  }

  // -------------------------------------------------------------------------
  // Normal mode execution

  private execNormal(cmd: Cmd): void | Promise<void> {
    const cur = this.normalCursor();
    const t = this.text();
    const count = cmd.count;
    const n = count ?? 1;
    if (cmd.kind === "motion") {
      const m = this.motion(cmd.name, cmd.arg, count, cur, null);
      if (m) {
        const keep = ["j", "k", "<Up>", "<Down>", "gj", "gk"].includes(cmd.name);
        this.setCursor(clampNormal(this.text(), m.pos), keep);
      }
      return;
    }
    const recordable = (enterInsert: boolean): Change | null => {
      if (this.replaying) return null;
      const keys = this.stripCount(cmd);
      const change = { keys, count, inserted: null };
      if (!enterInsert) this.lastChange = change;
      return change;
    };

    if (cmd.kind === "op") {
      const op = cmd.name;
      const total = count !== null || cmd.opCount != null ? (count ?? 1) * (cmd.opCount ?? 1) : null;
      const range = this.motionRange(cmd.target!, total, cur, op);
      if (!range) return;
      const snap = this.host.snapshot();
      switch (op) {
        case "d":
          this.writeRegister(cmd.reg, this.captureRange(range), "delete");
          this.deleteRange(range);
          this.commit(snap, cur);
          recordable(false);
          return;
        case "c": {
          this.writeRegister(cmd.reg, this.captureRange(range), "delete");
          const change = recordable(true);
          if (range.linewise) {
            const indent = this.indentOf(t, range.from);
            this.edit(range.from, range.to, indent, range.from + indent.length);
            this.enterInsert(range.from + indent.length, change, snap, cur);
          } else {
            this.edit(range.from, range.to, "", range.from);
            this.enterInsert(range.from, change, snap, cur);
          }
          return;
        }
        case "y":
        case "leader-y": {
          this.writeRegister(op === "leader-y" ? "+" : cmd.reg, this.captureRange(range), "yank");
          if (!range.linewise) this.setCursor(clampNormal(t, range.from));
          else if (range.from < lineStart(t, cur)) {
            this.setCursor(moveLines(t, cur, lineIndex(t, range.from) - lineIndex(t, cur), column(t, cur)));
          }
          return;
        }
        case "g~":
        case "gu":
        case "gU": {
          const fn = op === "g~" ? toggleCase : op === "gu" ? (s: string) => s.toLowerCase() : (s: string) => s.toUpperCase();
          this.transformRange(range, fn);
          this.setCursor(clampNormal(this.text(), range.linewise ? firstNonBlank(this.text(), range.from) : range.from));
          this.commit(snap, cur);
          recordable(false);
          return;
        }
        case "sa":
          if (!cmd.arg) return;
          this.surroundAdd(range, cmd.arg);
          this.setCursor(clampNormal(this.text(), range.from));
          this.commit(snap, cur);
          recordable(false);
          return;
      }
      return;
    }

    // Simple commands
    const ls = lineStart(t, cur);
    const le = lineEnd(t, cur);
    const snap = this.host.snapshot();
    const change = (fn: () => void) => {
      fn();
      this.commit(snap, cur);
      recordable(false);
    };
    switch (cmd.name) {
      case "i":
        this.enterInsert(cur, recordable(true));
        return;
      case "a":
        this.enterInsert(le > ls ? Math.min(cur + 1, le) : cur, recordable(true));
        return;
      case "I":
        this.enterInsert(firstNonBlank(t, cur), recordable(true));
        return;
      case "A":
        this.enterInsert(le, recordable(true));
        return;
      case "o": {
        const indent = this.indentOf(t, cur);
        const c = recordable(true);
        this.edit(le, le, "\n" + indent, le + 1 + indent.length);
        this.enterInsert(le + 1 + indent.length, c, snap, cur);
        return;
      }
      case "O": {
        const indent = this.indentOf(t, cur);
        const c = recordable(true);
        this.edit(ls, ls, indent + "\n", ls + indent.length);
        this.enterInsert(ls + indent.length, c, snap, cur);
        return;
      }
      case "s-then": {
        // `s` followed by a key that is not a surround action: substitute,
        // then type the key in Insert mode.
        const c = recordable(true);
        const end = Math.min(le, cur + n);
        this.writeRegister(cmd.reg, this.captureRange({ from: cur, to: end, linewise: false }), "delete");
        this.edit(cur, end, "", cur);
        this.enterInsert(cur, c ? { ...c, keys: ["s", "<substitute>"] } : null, snap, cur);
        if (cmd.arg && cmd.arg !== "<substitute>") this.insertKey(cmd.arg, true);
        return;
      }
      case "x":
      case "<Del>": {
        if (le === ls) return;
        const end = Math.min(le, cur + n);
        change(() => {
          this.writeRegister(cmd.reg, this.captureRange({ from: cur, to: end, linewise: false }), "delete");
          this.edit(cur, end, "", cur);
          this.setCursor(clampNormal(this.text(), cur));
        });
        return;
      }
      case "X": {
        const from = Math.max(ls, cur - n);
        if (from === cur) return;
        change(() => {
          this.writeRegister(cmd.reg, this.captureRange({ from, to: cur, linewise: false }), "delete");
          this.edit(from, cur, "", from);
        });
        return;
      }
      case "D":
      case "C": {
        const lastLine = startOfLine(t, lineIndex(t, cur) + n - 1);
        const end = lineEnd(t, lastLine);
        this.writeRegister(cmd.reg, this.captureRange({ from: cur, to: end, linewise: false }), "delete");
        if (cmd.name === "D") {
          change(() => {
            this.edit(cur, end, "", cur);
            this.setCursor(clampNormal(this.text(), cur));
          });
        } else {
          const c = recordable(true);
          this.edit(cur, end, "", cur);
          this.enterInsert(cur, c, snap, cur);
        }
        return;
      }
      case "S": {
        const last = startOfLine(t, lineIndex(t, cur) + n - 1);
        const end = lineEnd(t, last);
        this.writeRegister(cmd.reg, this.captureRange({ from: ls, to: end, linewise: true }), "delete");
        const indent = this.indentOf(t, cur);
        const c = recordable(true);
        this.edit(ls, end, indent, ls + indent.length);
        this.enterInsert(ls + indent.length, c, snap, cur);
        return;
      }
      case "Y": {
        const lastLine = startOfLine(t, lineIndex(t, cur) + n - 1);
        this.writeRegister(cmd.reg, this.captureRange({ from: cur, to: lineEnd(t, lastLine), linewise: false }), "yank");
        return;
      }
      case "p":
      case "P": {
        const keys = this.stripCount(cmd);
        if (!this.replaying) this.lastChange = { keys, count, inserted: null };
        return this.put(cmd.reg, n, cmd.name === "P", cur);
      }
      case "r": {
        if (!cmd.arg || cur + n > le) return;
        change(() => {
          if (cmd.arg === "\n") {
            this.edit(cur, cur + n, "\n", cur + 1);
          } else {
            this.edit(cur, cur + n, cmd.arg!.repeat(n), cur + n - 1, []);
          }
        });
        return;
      }
      case "~": {
        if (le === ls) return;
        const end = Math.min(le, cur + n);
        change(() => {
          this.edit(cur, end, toggleCase(t.slice(cur, end)), cur);
          this.setCursor(clampNormal(this.text(), end));
        });
        return;
      }
      case "J":
      case "gJ":
        change(() => this.joinLines(cur, n, cmd.name === "J"));
        return;
      case ">":
      case "<": {
        const last = startOfLine(t, lineIndex(t, cur) + n - 1);
        change(() => this.indentLines(cur, last, cmd.name === ">" ? 1 : -1, 1));
        return;
      }
      case "u":
        this.undo(n);
        return;
      case "<C-r>":
        this.redo(n);
        return;
      case ".":
        this.repeatLast(count);
        return;
      case "+":
        this.starSearch(true, false, 1);
        return;
      case "v":
      case "V":
        this.enterVisual(cmd.name === "v" ? "visual" : "vline", cur, cur);
        return;
      case "gv":
        if (this.lastVisual) this.enterVisual(this.lastVisual.mode, this.lastVisual.anchor, this.lastVisual.head);
        return;
      case "sd":
        if (cmd.arg) change(() => this.surroundDelete(cur, cmd.arg!));
        return;
      case "sr":
        if (cmd.arg && cmd.arg2) change(() => this.surroundDelete(cur, cmd.arg!, cmd.arg2!));
        return;
      case "<A-j>":
      case "<A-k>":
        change(() => {
          this.moveLinesBy(cur, cur, cmd.name === "<A-j>" ? n : -n);
        });
        return;
      case "<A-h>":
      case "<A-l>":
        change(() => this.indentLines(cur, cur, cmd.name === "<A-l>" ? 1 : -1, n));
        return;
      case "<C-d>":
        this.host.scroll("halfDown", n);
        return;
      case "<C-u>":
        this.host.scroll("halfUp", n);
        return;
      case "<C-e>":
        this.host.scroll("lineDown", n);
        return;
      case "<C-y>":
        this.host.scroll("lineUp", n);
        return;
    }
  }

  private stripCount(cmd: Cmd): string[] {
    const keys = [...cmd.keys];
    let i = keys[0] === '"' ? 2 : 0;
    const start = i;
    while (isDigit(keys[i]) && (i > start || keys[i] !== "0")) i++;
    keys.splice(start, i - start);
    return keys;
  }

  private repeatLast(count: number | null): void {
    const change = this.lastChange;
    if (!change) return;
    this.replaying = true;
    try {
      const prefix = count !== null ? String(count).split("") : change.count !== null ? String(change.count).split("") : [];
      const keys = change.keys[0] === '"' ? [...change.keys.slice(0, 2), ...prefix, ...change.keys.slice(2)] : [...prefix, ...change.keys];
      this.pending = [];
      for (const k of keys) {
        if (k === "<substitute>") continue;
        const r = this.commandKey(k);
        if (r instanceof Promise) break;
      }
      if (this.pending.length > 0 && this.pending[this.pending.length - 1] === "s") this.flushTimers();
      if (this.mode === "insert") {
        if (change.inserted) {
          const cur = this.cursor();
          this.edit(cur, cur, change.inserted, cur + change.inserted.length, []);
        }
        this.exitInsert();
      }
    } finally {
      this.replaying = false;
    }
  }

  // -------------------------------------------------------------------------
  // Visual mode

  private enterVisual(mode: "visual" | "vline", anchor: number, head: number): void {
    this.mode = mode;
    this.anchor = anchor;
    this.host.setCursor(head);
    this.showVisual(head);
  }

  private exitVisual(cursor?: number): void {
    const head = this.visualHead();
    if (this.mode === "visual" || this.mode === "vline") {
      this.lastVisual = { anchor: this.anchor, head, mode: this.mode };
    }
    this.mode = "normal";
    this.headOverride = null;
    this.setCursor(clampNormal(this.text(), cursor ?? head));
  }

  private showVisual(head: number): void {
    const r = this.visualRange(head);
    this.host.setSelection(r.from, r.linewise ? r.to : r.to);
    this.headOverride = head;
  }

  /** Visual head kept separately because the host selection spans the range. */
  private headOverride: number | null = null;

  private visualHead(): number {
    return this.headOverride ?? this.cursor();
  }

  private visualRange(head = this.visualHead()): Range {
    const t = this.text();
    const from = Math.min(this.anchor, head);
    const max = Math.max(this.anchor, head);
    if (this.mode === "vline") return { from: lineStart(t, from), to: lineEnd(t, max), linewise: true };
    return { from, to: Math.min(t.length, max + 1), linewise: false };
  }

  private execVisual(cmd: Cmd): void | Promise<void> {
    const head = this.visualHead();
    const t = this.text();
    const n = cmd.count ?? 1;
    // Visual edits are not dot-repeatable; clear the stored change so `.`
    // does not replay something unrelated.
    if (!this.replaying && VISUAL_CHANGES.has(cmd.name)) this.lastChange = null;
    if (cmd.kind === "motion") {
      const m = this.motion(cmd.name, cmd.arg, cmd.count, head, null);
      if (m) {
        const keep = ["j", "k", "<Up>", "<Down>", "gj", "gk"].includes(cmd.name);
        if (!keep) this.goalCol = null;
        this.showVisual(m.pos);
      }
      return;
    }
    const range = this.visualRange(head);
    const snap = this.host.snapshot();
    const startCur = Math.min(this.anchor, head);
    const finish = (cursor: number) => {
      this.exitVisual(cursor);
      this.commit(snap, startCur);
    };
    const lineRange = (): Range => ({ from: lineStart(t, range.from), to: lineEnd(t, Math.max(range.from, range.to - 1)), linewise: true });
    if (cmd.kind === "op") {
      switch (cmd.name) {
        case "g~":
        case "gu":
        case "gU": {
          const fn = cmd.name === "g~" ? toggleCase : cmd.name === "gu" ? (s: string) => s.toLowerCase() : (s: string) => s.toUpperCase();
          this.transformRange(range, fn);
          finish(range.from);
          return;
        }
        case "leader-y":
          this.writeRegister("+", this.captureRange(range), "yank");
          this.exitVisual(range.from);
          return;
        case "sa":
          if (cmd.arg) this.surroundAdd(range, cmd.arg);
          finish(range.from);
          return;
      }
      return;
    }
    switch (cmd.name) {
      case "v":
      case "V": {
        const target = cmd.name === "v" ? "visual" : "vline";
        if (this.mode === target) this.exitVisual();
        else {
          this.mode = target;
          this.showVisual(head);
        }
        return;
      }
      case "o":
      case "O": {
        const a = this.anchor;
        this.anchor = head;
        this.host.setCursor(a);
        this.showVisual(a);
        return;
      }
      case "textobj": {
        const r = this.textObject(cmd.arg!, cmd.arg2 === "i", n, this.anchor, head);
        if (!r || r.to <= r.from) return;
        if (r.linewise && this.mode === "visual") this.mode = "vline";
        this.anchor = r.from;
        this.showVisual(Math.max(r.from, r.to - 1));
        return;
      }
      case "d":
      case "x":
      case "<Del>":
        this.writeRegister(cmd.reg, this.captureRange(range), "delete");
        this.deleteRange(range);
        finish(range.linewise ? this.cursor() : range.from);
        return;
      case "D":
      case "X": {
        const r = lineRange();
        this.writeRegister(cmd.reg, this.captureRange(r), "delete");
        this.deleteRange(r);
        finish(this.cursor());
        return;
      }
      case "y":
        this.writeRegister(cmd.reg, this.captureRange(range), "yank");
        this.exitVisual(range.from);
        return;
      case "Y":
        this.writeRegister(cmd.reg, this.captureRange(lineRange()), "yank");
        this.exitVisual(range.from);
        return;
      case "c":
      case "s":
      case "s-then":
      case "C":
      case "S": {
        const r = cmd.name === "C" || cmd.name === "S" || range.linewise ? lineRange() : range;
        this.writeRegister(cmd.reg, this.captureRange(r), "delete");
        this.lastVisual = { anchor: this.anchor, head, mode: this.mode as "visual" | "vline" };
        if (r.linewise) {
          const indent = this.indentOf(t, r.from);
          this.edit(r.from, r.to, indent, r.from + indent.length);
          this.enterInsert(r.from + indent.length, null, snap, startCur);
        } else {
          this.edit(r.from, r.to, "", r.from);
          this.enterInsert(r.from, null, snap, startCur);
        }
        if (cmd.name === "s-then" && cmd.arg && cmd.arg !== "<substitute>") this.insertKey(cmd.arg, true);
        return;
      }
      case "I":
        this.exitVisual(range.from);
        this.enterInsert(range.linewise ? firstNonBlank(t, range.from) : range.from, null);
        return;
      case "A":
        this.exitVisual(range.to);
        this.enterInsert(range.linewise ? range.to : range.to, null);
        return;
      case "~":
      case "u":
      case "U": {
        const fn = cmd.name === "~" ? toggleCase : cmd.name === "u" ? (s: string) => s.toLowerCase() : (s: string) => s.toUpperCase();
        this.transformRange(range, fn);
        finish(range.from);
        return;
      }
      case "J":
      case "gJ": {
        const lines = lineIndex(t, range.to) - lineIndex(t, range.from) + 1;
        this.joinLines(range.from, Math.max(2, lines), cmd.name === "J");
        finish(this.cursor());
        return;
      }
      case "r": {
        if (!cmd.arg) return;
        const ch = cmd.arg;
        this.transformRange(range, (s) => s.replace(/[^\n]/g, ch));
        finish(range.from);
        return;
      }
      case ">":
      case "<": {
        // nvim mapping: >gv keeps the selection.
        const a = this.anchor;
        this.indentLines(range.from, Math.max(range.from, range.to - 1), cmd.name === ">" ? 1 : -1, n);
        this.commit(snap, startCur);
        const nt = this.text();
        const delta = nt.length - t.length;
        const fromLine = lineIndex(t, range.from);
        const toLine = lineIndex(t, Math.max(range.from, range.to - 1));
        if (this.mode === "vline") {
          this.anchor = startOfLine(nt, a <= head ? fromLine : toLine);
          this.showVisual(startOfLine(nt, a <= head ? toLine : fromLine));
        } else {
          this.anchor = Math.max(0, a + (a <= head ? 0 : delta));
          this.showVisual(Math.max(0, head + (a <= head ? delta : 0)));
        }
        return;
      }
      case "<A-j>":
      case "<A-k>": {
        const r = lineRange();
        const moved = this.moveLinesBy(r.from, Math.max(r.from, r.to - 1), cmd.name === "<A-j>" ? n : -n);
        if (!moved) return;
        this.commit(snap, startCur);
        const nt = this.text();
        this.mode = "vline";
        const forward = this.anchor <= head;
        this.anchor = forward ? moved.first : moved.last;
        this.showVisual(forward ? Math.max(moved.last, lineEnd(nt, moved.last) - 1) : moved.first);
        return;
      }
      case "<A-h>":
      case "<A-l>": {
        const a = this.anchor;
        this.indentLines(range.from, Math.max(range.from, range.to - 1), cmd.name === "<A-l>" ? 1 : -1, n);
        this.commit(snap, startCur);
        this.anchor = a;
        this.showVisual(head);
        return;
      }
      case "p":
      case "P":
        return this.visualPut(cmd, range, snap, startCur);
      case "<C-d>":
        this.host.scroll("halfDown", n);
        return;
      case "<C-u>":
        this.host.scroll("halfUp", n);
        return;
      case "<C-e>":
        this.host.scroll("lineDown", n);
        return;
      case "<C-y>":
        this.host.scroll("lineUp", n);
        return;
    }
  }

  private async visualPut(cmd: Cmd, range: Range, snap: Snapshot, startCur: number): Promise<void> {
    const r = await this.resolvePut(cmd.reg);
    if (!r) return;
    const replaced = this.captureRange(range);
    let text = r.text;
    if (r.linewise && !range.linewise) text = "\n" + text;
    else if (!r.linewise && range.linewise) text = text;
    else if (r.linewise && range.linewise) text = text.endsWith("\n") ? text.slice(0, -1) : text;
    this.edit(range.from, range.to, text, range.from, r.atoms);
    if (cmd.name === "p") this.writeRegister(null, replaced, "delete");
    this.exitVisual(range.linewise ? firstNonBlank(this.text(), range.from) : Math.max(range.from, range.from + text.length - 1));
    this.commit(snap, startCur);
  }

  /** The document was replaced outside the engine (for example after submit). */
  externalReset(): void {
    if (this.mode === "insert") {
      this.session = null;
      this.beginInsertSession(null);
      return;
    }
    this.focusReset();
  }
}
