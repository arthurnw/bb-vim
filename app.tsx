import { definePluginApp, experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { useEffect, useReducer, useRef } from "react";
import { installComposerVim } from "./src/controller";
import { DEFAULT_OPTIONS, type ClipboardPolicy, type EngineOptions } from "./src/host";
import { getStatus, isIndicatorEnabled, setIndicatorEnabled, subscribe } from "./src/store";

interface Settings {
  clipboard?: unknown;
  readlineKeys?: unknown;
  autoPairs?: unknown;
  showModeIndicator?: unknown;
}

function toOptions(s: Settings): EngineOptions {
  const clipboard: ClipboardPolicy =
    s.clipboard === "all" || s.clipboard === "never" || s.clipboard === "yank" ? s.clipboard : DEFAULT_OPTIONS.clipboard;
  return {
    ...DEFAULT_OPTIONS,
    clipboard,
    readlineKeys: s.readlineKeys !== false,
    autoPairs: s.autoPairs === true,
  };
}

async function fetchSettings(pluginId: string, signal: AbortSignal): Promise<Settings | null> {
  try {
    const res = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/settings`, { signal });
    return res.ok ? ((await res.json()) as Settings) : null;
  } catch {
    return null;
  }
}

const MODE_COLORS: Record<string, string> = {
  NORMAL: "#3b82f6",
  VISUAL: "#a855f7",
  "V-LINE": "#a855f7",
  "(insert)": "#3b82f6",
};

function ModeBadge() {
  const ref = useRef<HTMLSpanElement>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    rerender();
    return subscribe(rerender);
  }, []);
  const el = ref.current;
  const composer =
    el?.closest("[data-promptbox]") ?? el?.closest("[data-app-composer]")?.querySelector("[data-promptbox]") ?? null;
  const status = getStatus(composer);
  const visible = status !== null && isIndicatorEnabled();
  const text = status ? (status.searchLine ?? (status.pending ? `${status.label} ${status.pending}` : status.label)) : "";
  return (
    <span
      ref={ref}
      aria-live="polite"
      data-composer-vim-badge=""
      style={{
        display: visible ? "inline-flex" : "none",
        alignItems: "center",
        alignSelf: "center",
        height: 20,
        padding: "0 6px",
        marginRight: 4,
        borderRadius: 4,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        color: status && MODE_COLORS[status.label] ? MODE_COLORS[status.label] : "currentColor",
        opacity: status?.mode === "insert" ? 0.5 : 1,
      }}
    >
      {text}
    </span>
  );
}

export default definePluginApp((app) => {
  let options = DEFAULT_OPTIONS;

  app.composer.customize({
    id: "vim-mode",
    actions: [{ id: "mode", component: ModeBadge }],
  });

  app.contentScripts.register({
    id: "composer-vim",
    async mount({ pluginId, signal }) {
      let lastFetch = 0;
      const refresh = async () => {
        lastFetch = Date.now();
        const s = await fetchSettings(pluginId, signal);
        if (!s || signal.aborted) return;
        options = toOptions(s);
        setIndicatorEnabled(s.showModeIndicator !== false);
      };
      await refresh();
      installComposerVim({
        signal,
        copy: (text) => void experimental_copyToClipboard({ text }),
        options: () => options,
        onFocus: () => {
          if (Date.now() - lastFetch > 2000) void refresh();
        },
      });
    },
  });
});
