import type { Status } from "./engine";

// Mode status per composer, shared between the content script and the
// composer action that renders the mode badge.

type Listener = () => void;

const statuses = new WeakMap<Element, Status>();
const listeners = new Set<Listener>();
let indicatorEnabled = true;

export function setStatus(composer: Element, status: Status | null): void {
  if (status) statuses.set(composer, status);
  else statuses.delete(composer);
  for (const l of listeners) l();
}

export function getStatus(composer: Element | null): Status | null {
  return composer ? (statuses.get(composer) ?? null) : null;
}

export function setIndicatorEnabled(enabled: boolean): void {
  if (indicatorEnabled === enabled) return;
  indicatorEnabled = enabled;
  for (const l of listeners) l();
}

export function isIndicatorEnabled(): boolean {
  return indicatorEnabled;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
