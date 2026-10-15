// Pure text helpers over the flat composer text. Lines are separated by "\n";
// inline atoms (mention pills) appear as ATOM.

export const ATOM = "￼";

export const enum CharClass {
  Space = 0,
  Punct = 1,
  Word = 2,
}

const WORD_RE = /[\p{L}\p{N}_]/u;

export function charClass(ch: string | undefined, bigWord = false): CharClass {
  if (ch === undefined || /\s/.test(ch)) return CharClass.Space;
  if (bigWord) return CharClass.Word;
  if (ch === ATOM) return CharClass.Punct;
  return WORD_RE.test(ch) ? CharClass.Word : CharClass.Punct;
}

export function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

export function lineStart(t: string, pos: number): number {
  const i = t.lastIndexOf("\n", pos - 1);
  return i + 1;
}

/** Index of the line's "\n", or t.length on the last line. */
export function lineEnd(t: string, pos: number): number {
  const i = t.indexOf("\n", pos);
  return i === -1 ? t.length : i;
}

export function firstNonBlank(t: string, pos: number): number {
  let i = lineStart(t, pos);
  const end = lineEnd(t, pos);
  while (i < end && isBlank(t[i])) i++;
  return i;
}

/** Last character a Normal-mode cursor may sit on for this line. */
export function lastCharOfLine(t: string, pos: number): number {
  const s = lineStart(t, pos);
  const e = lineEnd(t, pos);
  return e > s ? e - 1 : s;
}

export function clampNormal(t: string, pos: number): number {
  if (t.length === 0) return 0;
  pos = Math.max(0, Math.min(pos, t.length));
  const s = lineStart(t, pos);
  const e = lineEnd(t, pos);
  if (pos >= e && e > s) return e - 1;
  return pos;
}

export function lineIndex(t: string, pos: number): number {
  let n = 0;
  for (let i = 0; i < pos && i < t.length; i++) if (t[i] === "\n") n++;
  return n;
}

export function lineCount(t: string): number {
  let n = 1;
  for (let i = 0; i < t.length; i++) if (t[i] === "\n") n++;
  return n;
}

/** Start offset of the zero-based line, clamped to the last line. */
export function startOfLine(t: string, line: number): number {
  let pos = 0;
  for (let n = 0; n < line; n++) {
    const i = t.indexOf("\n", pos);
    if (i === -1) return pos;
    pos = i + 1;
  }
  return pos;
}

export function column(t: string, pos: number): number {
  return pos - lineStart(t, pos);
}

/** Move by whole lines keeping the goal column. */
export function moveLines(t: string, pos: number, delta: number, goalCol: number): number {
  const total = lineCount(t);
  const target = Math.max(0, Math.min(total - 1, lineIndex(t, pos) + delta));
  const s = startOfLine(t, target);
  const e = lineEnd(t, s);
  return Math.min(s + goalCol, e > s ? e - 1 : s);
}

// ---------------------------------------------------------------------------
// Word motions

function isEmptyLineAt(t: string, i: number): boolean {
  return t[i] === "\n" && (i === 0 || t[i - 1] === "\n");
}

export function wordForward(t: string, pos: number, big: boolean): number {
  const n = t.length;
  if (pos >= n) return n;
  let i = pos;
  const c = charClass(t[i], big);
  if (c !== CharClass.Space) {
    while (i < n && charClass(t[i], big) === c) i++;
  }
  while (i < n && charClass(t[i], big) === CharClass.Space) {
    if (t[i] === "\n") {
      i++;
      if (isEmptyLineAt(t, i) || (i === n && t[n - 1] === "\n")) return i;
      continue;
    }
    i++;
  }
  return i;
}

export function wordEnd(t: string, pos: number, big: boolean): number {
  const n = t.length;
  let i = pos + 1;
  while (i < n && charClass(t[i], big) === CharClass.Space) i++;
  if (i >= n) return Math.max(0, n - 1);
  const c = charClass(t[i], big);
  while (i + 1 < n && charClass(t[i + 1], big) === c) i++;
  return i;
}

export function wordBackward(t: string, pos: number, big: boolean): number {
  let i = pos - 1;
  while (i > 0 && charClass(t[i], big) === CharClass.Space) {
    if (isEmptyLineAt(t, i)) return i;
    i--;
  }
  if (i <= 0) return 0;
  const c = charClass(t[i], big);
  while (i > 0 && charClass(t[i - 1], big) === c) i--;
  return i;
}

export function wordEndBackward(t: string, pos: number, big: boolean): number {
  let i = pos;
  const c = charClass(t[i], big);
  if (c !== CharClass.Space) while (i > 0 && charClass(t[i - 1], big) === c) i--;
  i--;
  while (i > 0 && charClass(t[i], big) === CharClass.Space && !isEmptyLineAt(t, i)) i--;
  return Math.max(0, i);
}

// ---------------------------------------------------------------------------
// Paragraph motions

function lineIsBlank(t: string, s: number): boolean {
  const e = lineEnd(t, s);
  for (let i = s; i < e; i++) if (!/\s/.test(t[i])) return false;
  return true;
}

export function paragraphForward(t: string, pos: number): number {
  let s = lineStart(t, pos);
  // Skip blank lines, then the paragraph, landing on the next blank line.
  while (s < t.length && lineIsBlank(t, s)) {
    const e = lineEnd(t, s);
    if (e >= t.length) return t.length;
    s = e + 1;
  }
  while (true) {
    const e = lineEnd(t, s);
    if (e >= t.length) return t.length;
    s = e + 1;
    if (lineIsBlank(t, s)) return s;
  }
}

export function paragraphBackward(t: string, pos: number): number {
  let s = lineStart(t, pos);
  while (s > 0 && lineIsBlank(t, s)) s = lineStart(t, s - 1);
  while (s > 0) {
    s = lineStart(t, s - 1);
    if (lineIsBlank(t, s)) return s;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Character find

export function findChar(
  t: string,
  pos: number,
  ch: string,
  forward: boolean,
  till: boolean,
  count: number,
  repeat = false,
): number | null {
  const s = lineStart(t, pos);
  const e = lineEnd(t, pos);
  let i = pos;
  for (let n = 0; n < count; n++) {
    let j = forward ? i + 1 : i - 1;
    // Repeating a till motion must step past the adjacent match.
    if (till && repeat && n === 0) {
      if (forward && t[j] === ch) j++;
      if (!forward && t[j] === ch) j--;
    }
    while (j >= s && j < e && t[j] !== ch) j += forward ? 1 : -1;
    if (j < s || j >= e) return null;
    i = j;
  }
  if (till) i += forward ? -1 : 1;
  return i;
}

// ---------------------------------------------------------------------------
// Brackets and quotes

export const OPEN_TO_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
export const CLOSE_TO_OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

export function matchPair(t: string, pos: number): number | null {
  const e = lineEnd(t, pos);
  let i = pos;
  while (i < e && !"()[]{}".includes(t[i])) i++;
  if (i >= e) return null;
  const ch = t[i];
  if (ch in OPEN_TO_CLOSE) return scanClose(t, i + 1, ch, OPEN_TO_CLOSE[ch]);
  return scanOpen(t, i - 1, CLOSE_TO_OPEN[ch], ch);
}

function scanClose(t: string, from: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = from; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

function scanOpen(t: string, from: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = from; i >= 0; i--) {
    if (t[i] === close) depth++;
    else if (t[i] === open) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

export interface Pair {
  open: number;
  close: number;
}

/** Smallest bracket pair enclosing pos, or the next one after it (mini.ai). */
export function findBracketPair(t: string, pos: number, opens: string[]): Pair | null {
  let best: Pair | null = null;
  for (const open of opens) {
    const close = OPEN_TO_CLOSE[open];
    let o: number | null;
    if (t[pos] === open) o = pos;
    else if (t[pos] === close) o = scanOpen(t, pos - 1, open, close);
    else o = scanOpen(t, pos - 1, open, close);
    if (o === null) continue;
    const c = scanClose(t, o + 1, open, close);
    if (c === null || c < pos) continue;
    if (!best || o > best.open) best = { open: o, close: c };
  }
  if (best) return best;
  // Cover-or-next: the first pair that starts after the cursor.
  let next: Pair | null = null;
  for (const open of opens) {
    const close = OPEN_TO_CLOSE[open];
    const o = t.indexOf(open, pos + 1);
    if (o === -1) continue;
    const c = scanClose(t, o + 1, open, close);
    if (c === null) continue;
    if (!next || o < next.open) next = { open: o, close: c };
  }
  return next;
}

function quotePositions(t: string, s: number, e: number, q: string): number[] {
  const out: number[] = [];
  for (let i = s; i < e; i++) {
    if (t[i] !== q) continue;
    let bs = 0;
    for (let j = i - 1; j >= s && t[j] === "\\"; j--) bs++;
    if (bs % 2 === 0) out.push(i);
  }
  return out;
}

/** Line-local quote pair containing pos, or the next one on the line. */
export function findQuotePair(t: string, pos: number, quotes: string[]): Pair | null {
  const s = lineStart(t, pos);
  const e = lineEnd(t, pos);
  let best: Pair | null = null;
  let next: Pair | null = null;
  for (const q of quotes) {
    const qs = quotePositions(t, s, e, q);
    for (let k = 0; k + 1 < qs.length; k += 2) {
      const p = { open: qs[k], close: qs[k + 1] };
      if (p.open <= pos && pos <= p.close) {
        if (!best || p.open > best.open) best = p;
      } else if (p.open > pos && (!next || p.open < next.open)) {
        next = p;
      }
    }
  }
  return best ?? next;
}

// ---------------------------------------------------------------------------
// Case

export function toggleCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += ch === up ? ch.toLowerCase() : up;
  }
  return out;
}
