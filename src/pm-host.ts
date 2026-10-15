import type { Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { EditorHost, ScrollKind, SearchMatch, Snapshot } from "./host";
import { ATOM } from "./text";

/** The TipTap editor bb attaches to its ProseMirror root as `dom.editor`. */
export interface TiptapEditor {
  view: EditorView;
  state: EditorState;
  isDestroyed: boolean;
  on(event: string, fn: (...args: any[]) => void): unknown;
  off(event: string, fn: (...args: any[]) => void): unknown;
}

/** Transactions created by this plugin carry this meta key. */
export const VIM_META = "composerVim";

interface Flat {
  doc: PMNode;
  text: string;
  /** pos[i] is the document position before flat character i; pos[text.length] is the end. */
  pos: number[];
  atoms: { index: number; node: PMNode }[];
}

function buildFlat(doc: PMNode): Flat {
  let text = "";
  const pos: number[] = [];
  const atoms: Flat["atoms"] = [];
  let first = true;
  let lastEnd = 1;
  doc.descendants((node, p) => {
    if (!node.isTextblock) return true;
    if (!first) {
      text += "\n";
      pos.push(lastEnd);
    }
    first = false;
    node.forEach((child, offset) => {
      const cp = p + 1 + offset;
      if (child.isText) {
        const s = child.text ?? "";
        for (let k = 0; k < s.length; k++) pos.push(cp + k);
        text += s;
      } else if (child.type.name === "hardBreak") {
        text += "\n";
        pos.push(cp);
      } else {
        atoms.push({ index: text.length, node: child });
        text += ATOM;
        pos.push(cp);
      }
    });
    lastEnd = p + 1 + node.content.size;
    return false;
  });
  pos.push(lastEnd);
  return { doc, text, pos, atoms };
}

const HIGHLIGHT_NAME = "composer-vim-search";

export class ProseMirrorHost implements EditorHost {
  private cache: Flat | null = null;
  private highlighted = false;
  /**
   * Edits for the current key accumulate in one transaction that is dispatched
   * from a Promise job. bb blocks DOM moves made while plugin-registered
   * listeners run, and ProseMirror moves mention-pill node views while
   * updating; dispatching outside that scope matches bb's own edit path.
   */
  private pending: Transaction | null = null;

  constructor(
    private editor: TiptapEditor,
    private copy: (text: string) => void,
  ) {}

  private get view(): EditorView {
    return this.editor.view;
  }

  private get doc(): PMNode {
    return this.pending?.doc ?? this.view.state.doc;
  }

  private flat(doc: PMNode = this.doc): Flat {
    if (this.cache?.doc !== doc) this.cache = buildFlat(doc);
    return this.cache;
  }

  private toFlat(f: Flat, p: number): number {
    let lo = 0;
    let hi = f.pos.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f.pos[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private toPos(f: Flat, i: number): number {
    return f.pos[Math.max(0, Math.min(i, f.text.length))];
  }

  private textSelection() {
    // Use the editor's own ProseMirror classes; a bundled copy would fail
    // its instanceof checks.
    const state = this.view.state;
    const Sel = state.selection.constructor as unknown as {
      near(pos: ReturnType<PMNode["resolve"]>): { constructor: unknown };
    };
    return Sel.near(state.doc.resolve(Math.min(1, state.doc.content.size))).constructor as {
      create(doc: PMNode, anchor: number, head?: number): any;
    };
  }

  private tr(): Transaction {
    if (!this.pending) {
      this.pending = this.view.state.tr;
      void Promise.resolve().then(() => this.flush());
    }
    return this.pending;
  }

  /** Dispatch pending edits now. */
  flush(): void {
    const tr = this.pending;
    this.pending = null;
    if (!tr || this.editor.isDestroyed) return;
    if (!tr.docChanged && !tr.selectionSet) return;
    tr.setMeta(VIM_META, true);
    tr.scrollIntoView();
    this.view.dispatch(tr);
  }

  get hasPendingEdits(): boolean {
    return this.pending?.docChanged ?? false;
  }

  text(): string {
    return this.flat().text;
  }

  atomsIn(from: number, to: number): unknown[] {
    return this.flat()
      .atoms.filter((a) => a.index >= from && a.index < to)
      .map((a) => a.node);
  }

  atomText(atom: unknown): string {
    const node = atom as PMNode;
    const serialized = node.attrs?.serializedText;
    return typeof serialized === "string" ? serialized : node.textContent;
  }

  selection(): { anchor: number; head: number } {
    const f = this.flat();
    const sel = this.pending?.selection ?? this.view.state.selection;
    return { anchor: this.toFlat(f, sel.anchor), head: this.toFlat(f, sel.head) };
  }

  private nodesFor(text: string, atoms: unknown[]): PMNode[][] {
    const { schema } = this.view.state;
    const lines: PMNode[][] = [[]];
    let buf = "";
    let k = 0;
    const flush = () => {
      if (buf) lines[lines.length - 1].push(schema.text(buf));
      buf = "";
    };
    for (const ch of text) {
      if (ch === "\n") {
        flush();
        lines.push([]);
      } else if (ch === ATOM) {
        flush();
        const atom = atoms[k++] as PMNode | undefined;
        if (atom) lines[lines.length - 1].push(atom);
      } else buf += ch;
    }
    flush();
    return lines;
  }

  replace(from: number, to: number, text: string, atoms: unknown[], cursor: number): void {
    const tr = this.tr();
    const f = this.flat(tr.doc);
    const a = this.toPos(f, from);
    const b = this.toPos(f, to);
    const lines = this.nodesFor(text, atoms);
    const hardBreak = tr.doc.type.schema.nodes.hardBreak;
    if (hardBreak) {
      const nodes = lines.flatMap((line, i) => (i === 0 ? line : [hardBreak.create(), ...line]));
      if (nodes.length > 0) tr.replaceWith(a, b, nodes);
      else if (b > a) tr.delete(a, b);
    } else {
      if (b > a) tr.delete(a, b);
      let p = a;
      lines.forEach((line, i) => {
        if (i > 0) {
          tr.split(p);
          p += 2;
        }
        if (line.length > 0) {
          tr.insert(p, line);
          for (const n of line) p += n.nodeSize;
        }
      });
    }
    tr.setSelection(this.textSelection().create(tr.doc, this.toPos(this.flat(tr.doc), cursor)));
  }

  setCursor(pos: number): void {
    const sel = this.pending?.selection ?? this.view.state.selection;
    const p = this.toPos(this.flat(), pos);
    if (sel.empty && sel.head === p) return;
    const tr = this.tr();
    tr.setSelection(this.textSelection().create(tr.doc, p));
  }

  setSelection(from: number, to: number): void {
    const tr = this.tr();
    const f = this.flat(tr.doc);
    tr.setSelection(this.textSelection().create(tr.doc, this.toPos(f, from), this.toPos(f, to)));
  }

  snapshot(): Snapshot {
    return { id: this.doc };
  }

  isCurrent(s: Snapshot): boolean {
    const doc = s.id as PMNode;
    const cur = this.doc;
    return doc === cur || doc.eq(cur);
  }

  restore(s: Snapshot, cursor: number): void {
    const target = s.id as PMNode;
    const tr = this.tr();
    const start = tr.doc.content.findDiffStart(target.content);
    if (start !== null) {
      // Replace only the changed region so unchanged pills keep their views.
      const end = tr.doc.content.findDiffEnd(target.content)!;
      let endA = end.a;
      let endB = end.b;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      tr.replace(start, endA, target.slice(start, endB));
    }
    tr.setSelection(this.textSelection().create(tr.doc, this.toPos(this.flat(tr.doc), cursor)));
  }

  moveDisplayLine(pos: number, dir: 1 | -1, goalX: number | null): { pos: number; x: number } | null {
    // Coordinates come from the rendered view, which lags pending edits.
    if (this.hasPendingEdits) return null;
    const view = this.view;
    const f = this.flat();
    try {
      const c = view.coordsAtPos(this.toPos(f, pos));
      const x = goalX ?? c.left;
      const h = Math.max(8, c.bottom - c.top);
      const y = dir > 0 ? c.bottom + h / 2 : c.top - h / 2;
      const bounds = view.dom.getBoundingClientRect();
      if (y < bounds.top || y > bounds.bottom) return null;
      const hit = view.posAtCoords({ left: Math.max(bounds.left + 1, x), top: y });
      if (!hit) return null;
      const next = this.toFlat(f, hit.pos);
      if (next === pos) return null;
      const nc = view.coordsAtPos(hit.pos);
      if (Math.abs(nc.top - c.top) < 2) return null;
      return { pos: next, x };
    } catch {
      return null;
    }
  }

  writeClipboard(text: string): void {
    this.copy(text);
  }

  async readClipboard(): Promise<string | null> {
    try {
      const read = navigator.clipboard?.readText();
      if (!read) return null;
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500));
      return await Promise.race([read, timeout]);
    } catch {
      return null;
    }
  }

  setSearchHighlight(matches: SearchMatch[] | null): void {
    const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightCtor) return;
    if (!matches || matches.length === 0) {
      if (this.highlighted) registry.delete(HIGHLIGHT_NAME);
      this.highlighted = false;
      return;
    }
    const f = this.flat(this.view.state.doc);
    const ranges: Range[] = [];
    for (const m of matches) {
      try {
        const s = this.view.domAtPos(this.toPos(f, m.from));
        const e = this.view.domAtPos(this.toPos(f, m.to));
        const r = document.createRange();
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
        ranges.push(r);
      } catch {
        // Positions inside node views cannot be mapped; skip them.
      }
    }
    registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
    this.highlighted = true;
  }

  scroll(kind: ScrollKind, count: number): void {
    const el = findTranscriptScroller(this.view.dom as HTMLElement);
    if (!el) return;
    const half = el.clientHeight / 2;
    const line = 40;
    const delta = { halfDown: half, halfUp: -half, lineDown: line, lineUp: -line }[kind] * count;
    el.scrollBy({ top: delta });
  }

  /** Viewport rectangle of the flat character at pos, for the block cursor. */
  charRect(pos: number): { left: number; top: number; width: number; height: number } | null {
    const view = this.view;
    const f = this.flat(this.view.state.doc);
    try {
      const p = this.toPos(f, pos);
      const c = view.coordsAtPos(p, 1);
      let width = 0;
      const ch = f.text[pos];
      if (ch !== undefined && ch !== "\n") {
        const n = view.coordsAtPos(this.toPos(f, pos + 1), -1);
        if (Math.abs(n.top - c.top) < 2) width = n.left - c.left;
      }
      if (width <= 0) {
        const size = parseFloat(getComputedStyle(view.dom).fontSize) || 14;
        width = size * 0.6;
      }
      return { left: c.left, top: c.top, width, height: c.bottom - c.top };
    } catch {
      return null;
    }
  }
}

function isScrollable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const overflow = getComputedStyle(el).overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/** The transcript scroller sits directly above the composer. */
function findTranscriptScroller(dom: HTMLElement): HTMLElement | null {
  const composer = (dom.closest("[data-promptbox]") as HTMLElement | null) ?? dom;
  const rect = composer.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  for (const y of [rect.top - 40, rect.top - 120, rect.top / 2]) {
    if (y <= 0) continue;
    for (const el of document.elementsFromPoint(x, y)) {
      if (composer.contains(el)) continue;
      let node: Element | null = el;
      while (node && node !== document.body) {
        if (isScrollable(node) && !node.contains(composer)) return node;
        node = node.parentElement;
      }
    }
  }
  return null;
}

export function tiptapEditorOf(el: Element | null): TiptapEditor | null {
  const editor = (el as { editor?: TiptapEditor } | null)?.editor;
  return editor && editor.view && !editor.isDestroyed ? editor : null;
}

/** True when a TipTap suggestion popup (mentions, commands) is open. */
export function suggestionActive(state: EditorState): boolean {
  for (const plugin of state.plugins) {
    const value = (plugin as { getState?: (s: EditorState) => unknown }).getState?.(state);
    if (value && typeof value === "object" && (value as { active?: unknown }).active === true && "range" in value) {
      return true;
    }
  }
  return false;
}
