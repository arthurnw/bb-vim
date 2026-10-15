import type { EditorHost, ScrollKind, SearchMatch, Snapshot } from "../src/host";
import { ATOM } from "../src/text";

/** Plain-string host for engine tests. Atoms are strings like "@thread". */
export class MemoryHost implements EditorHost {
  value = "";
  atoms: string[] = [];
  anchor = 0;
  head = 0;
  clipboard: string | null = null;
  highlight: SearchMatch[] | null = null;
  scrolls: ScrollKind[] = [];

  constructor(text = "", cursor = 0) {
    this.value = text;
    this.anchor = this.head = cursor;
  }

  text(): string {
    return this.value;
  }
  private atomIndex(pos: number): number {
    return this.value.slice(0, pos).split(ATOM).length - 1;
  }
  atomsIn(from: number, to: number): unknown[] {
    return this.atoms.slice(this.atomIndex(from), this.atomIndex(to));
  }
  atomText(atom: unknown): string {
    return String(atom);
  }
  selection() {
    return { anchor: this.anchor, head: this.head };
  }
  replace(from: number, to: number, text: string, atoms: unknown[], cursor: number): void {
    const a = this.atomIndex(from);
    const b = this.atomIndex(to);
    const n = text.split(ATOM).length - 1;
    this.atoms.splice(a, b - a, ...(atoms.slice(0, n) as string[]));
    this.value = this.value.slice(0, from) + text + this.value.slice(to);
    this.anchor = this.head = cursor;
  }
  setCursor(pos: number): void {
    this.anchor = this.head = pos;
  }
  setSelection(from: number, to: number): void {
    this.anchor = from;
    this.head = to;
  }
  snapshot(): Snapshot {
    return { id: { value: this.value, atoms: [...this.atoms] } };
  }
  isCurrent(s: Snapshot): boolean {
    return (s.id as { value: string }).value === this.value;
  }
  restore(s: Snapshot, cursor: number): void {
    const id = s.id as { value: string; atoms: string[] };
    this.value = id.value;
    this.atoms = [...id.atoms];
    this.anchor = this.head = Math.min(cursor, this.value.length);
  }
  moveDisplayLine(): null {
    return null;
  }
  writeClipboard(text: string): void {
    this.clipboard = text;
  }
  async readClipboard(): Promise<string | null> {
    return this.clipboard;
  }
  setSearchHighlight(m: SearchMatch[] | null): void {
    this.highlight = m;
  }
  scroll(kind: ScrollKind): void {
    this.scrolls.push(kind);
  }
}
