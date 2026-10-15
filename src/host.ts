// The editor surface the Vim engine drives. Offsets are flat-text offsets
// (see text.ts); the ProseMirror adapter maps them onto document positions.

export type ClipboardPolicy = "all" | "yank" | "never";

export interface EngineOptions {
  clipboard: ClipboardPolicy;
  readlineKeys: boolean;
  autoPairs: boolean;
  /** Indent unit for >, <, and mini.move. */
  indent: string;
  /** Delay before a lone `s` acts as substitute (mini.surround prefix). */
  surroundTimeoutMs: number;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  clipboard: "yank",
  readlineKeys: true,
  autoPairs: false,
  indent: "  ",
  surroundTimeoutMs: 300,
};

export interface Snapshot {
  readonly id: unknown;
}

export interface SearchMatch {
  from: number;
  to: number;
}

export type ScrollKind = "halfDown" | "halfUp" | "lineDown" | "lineUp";

export interface EditorHost {
  text(): string;
  /** Opaque inline atoms (mention pills) in [from, to), in document order. */
  atomsIn(from: number, to: number): unknown[];
  /** Plain-text form of an atom, used for the OS clipboard. */
  atomText(atom: unknown): string;
  selection(): { anchor: number; head: number };
  /** Replace [from, to) with text, binding each ATOM placeholder to the next atom. */
  replace(from: number, to: number, text: string, atoms: unknown[], cursor: number): void;
  setCursor(pos: number): void;
  /** Show a selection covering [from, to). */
  setSelection(from: number, to: number): void;
  snapshot(): Snapshot;
  isCurrent(snapshot: Snapshot): boolean;
  restore(snapshot: Snapshot, cursor: number): void;
  /** Move one wrapped display line; null when the host cannot measure. */
  moveDisplayLine(pos: number, dir: 1 | -1, goalX: number | null): { pos: number; x: number } | null;
  writeClipboard(text: string): void;
  readClipboard(): Promise<string | null>;
  setSearchHighlight(matches: SearchMatch[] | null): void;
  scroll(kind: ScrollKind, count: number): void;
}
