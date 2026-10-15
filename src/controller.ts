import type { Transaction } from "prosemirror-state";
import { SharedVimState, VimEngine } from "./engine";
import type { EngineOptions } from "./host";
import { keyName } from "./keys";
import { ProseMirrorHost, VIM_META, suggestionActive, tiptapEditorOf, type TiptapEditor } from "./pm-host";
import { setStatus } from "./store";

const STYLE = `
.composer-vim-block { caret-color: transparent !important; }
.composer-vim-cursor {
  position: fixed;
  pointer-events: none;
  z-index: 2147483000;
  border-radius: 1px;
  opacity: 0.45;
  display: none;
}
::highlight(composer-vim-search) { background-color: rgba(250, 204, 21, 0.4); }
`;

const COMPOSER_SELECTOR = "[data-promptbox], [data-app-composer]";
const IGNORE_SELECTOR = "[data-bb-vim-ignore], [data-composer-vim-ignore]";

interface InstallOptions {
  signal: AbortSignal;
  copy: (text: string) => void;
  options: () => EngineOptions;
  onFocus?: () => void;
}

export function installComposerVim(opts: InstallOptions): void {
  const { signal } = opts;
  const shared = new SharedVimState();
  const controllers = new WeakMap<Element, Controller>();
  const live = new Set<Controller>();

  const style = document.createElement("style");
  style.dataset.composerVim = "";
  style.textContent = STYLE;
  document.head.append(style);
  const cursor = document.createElement("div");
  cursor.className = "composer-vim-cursor";
  document.body.append(cursor);

  class Controller {
    readonly host: ProseMirrorHost;
    readonly engine: VimEngine;
    private queue: Promise<unknown> | null = null;
    private frame = 0;
    private docChanged = false;
    windowBlurred = false;
    focused = false;

    constructor(
      readonly root: HTMLElement,
      readonly editor: TiptapEditor,
    ) {
      this.host = new ProseMirrorHost(editor, opts.copy);
      this.engine = new VimEngine(this.host, opts.options(), shared);
      this.engine.onAsyncChange = () => this.render();
      editor.on("transaction", this.onTransaction);
      editor.on("destroy", this.dispose);
      live.add(this);
    }

    get composer(): Element {
      return this.root.closest("[data-promptbox]") ?? this.root.closest(COMPOSER_SELECTOR) ?? this.root;
    }

    private onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        this.docChanged = true;
        // bb clears the composer after a submit: start the next prompt in Insert.
        if (!transaction.getMeta(VIM_META) && transaction.doc.textContent === "" && transaction.before.textContent !== "") {
          this.engine.externalReset();
        }
      }
      this.render();
    };

    dispose = () => {
      this.editor.off("transaction", this.onTransaction);
      this.editor.off("destroy", this.dispose);
      live.delete(this);
      setStatus(this.composer, null);
      this.root.classList.remove("composer-vim-block");
      if (active === this) {
        active = null;
        cursor.style.display = "none";
      }
    };

    keydown(e: KeyboardEvent): void {
      const key = keyName(e);
      if (!key) return;
      this.engine.options = opts.options();
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (this.queue) {
        // An async command (put from the clipboard) is running; queue keys
        // behind it so they apply in order.
        stop();
        this.enqueue(() => this.engine.handleKey(key, true));
        return;
      }
      if (this.engine.mode === "insert" && (key === "<Esc>" || key === "<C-[>") && suggestionActive(this.editor.state)) {
        // Let bb close its mention/command popup too.
        this.engine.handleKey(key);
        this.render();
        return;
      }
      const result = this.engine.handleKey(key);
      if (result === false) {
        this.render();
        return;
      }
      stop();
      if (result instanceof Promise) this.enqueue(() => result);
      this.render();
    }

    private enqueue(fn: () => unknown): void {
      const run = (this.queue ?? Promise.resolve()).then(fn).catch((err) => console.warn("[composer-vim]", err));
      this.queue = run;
      void run.then(() => {
        if (this.queue === run) this.queue = null;
        this.render();
      });
    }

    focus(): void {
      this.focused = true;
      if (!this.windowBlurred) this.engine.focusReset();
      this.windowBlurred = false;
      this.render();
    }

    blur(): void {
      this.focused = false;
      this.windowBlurred = !document.hasFocus();
      if (!this.windowBlurred) {
        this.engine.blur();
        this.engine.focusReset();
        this.host.setSearchHighlight(null);
      }
      this.render();
    }

    render(): void {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }

    private paint(): void {
      if (this.editor.isDestroyed || !this.root.isConnected) {
        this.dispose();
        return;
      }
      const status = this.engine.status();
      const composer = this.composer;
      setStatus(composer, this.focused ? status : null);
      composer.setAttribute("data-composer-vim-mode", status.mode);
      const block = this.focused && status.mode !== "insert";
      this.root.classList.toggle("composer-vim-block", block);
      if (this.docChanged) {
        this.docChanged = false;
        this.engine.refreshHighlight();
      }
      if (active !== this) return;
      const rect = block ? this.host.charRect(this.engine.displayCursor()) : null;
      if (!rect || !this.visible(rect)) {
        cursor.style.display = "none";
        return;
      }
      cursor.style.display = "block";
      cursor.style.left = `${rect.left}px`;
      cursor.style.top = `${rect.top}px`;
      cursor.style.width = `${rect.width}px`;
      cursor.style.height = `${rect.height}px`;
      cursor.style.background = getComputedStyle(this.root).color;
    }

    private visible(rect: { top: number; height: number }): boolean {
      let node: HTMLElement | null = this.root;
      while (node && node !== document.body) {
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
          const b = node.getBoundingClientRect();
          return rect.top + rect.height > b.top + 1 && rect.top < b.bottom - 1;
        }
        node = node.parentElement;
      }
      return true;
    }
  }

  let active: Controller | null = null;

  const activate = (c: Controller) => {
    opts.onFocus?.();
    active = c;
    c.focus();
  };

  const controllerFor = (target: EventTarget | null): Controller | null => {
    if (!(target instanceof Element)) return null;
    const root = target.closest(".ProseMirror");
    if (!(root instanceof HTMLElement)) return null;
    if (root.closest(IGNORE_SELECTOR) || !root.closest(COMPOSER_SELECTOR)) return null;
    const editor = tiptapEditorOf(root);
    if (!editor) return null;
    let c = controllers.get(root);
    if (!c || c.editor !== editor) {
      c?.dispose();
      c = new Controller(root, editor);
      controllers.set(root, c);
    }
    return c;
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented) return;
      const c = controllerFor(e.target);
      if (!c) return;
      if (!c.focused) activate(c);
      c.keydown(e);
    },
    { capture: true, signal },
  );

  document.addEventListener(
    "focusin",
    (e) => {
      const c = controllerFor(e.target);
      if (c) activate(c);
    },
    { signal },
  );

  document.addEventListener(
    "focusout",
    (e) => {
      const c = controllerFor(e.target);
      if (!c) return;
      c.blur();
      if (active === c) cursor.style.display = "none";
    },
    { signal },
  );

  // bb may have focused a composer before this script mounted.
  const initial = controllerFor(document.activeElement);
  if (initial) activate(initial);

  const repaint = () => active?.render();
  window.addEventListener("resize", repaint, { signal });
  document.addEventListener("scroll", repaint, { capture: true, passive: true, signal });

  signal.addEventListener("abort", () => {
    for (const c of [...live]) {
      c.host.setSearchHighlight(null);
      c.dispose();
      c.composer.removeAttribute("data-composer-vim-mode");
    }
    style.remove();
    cursor.remove();
  });
}
