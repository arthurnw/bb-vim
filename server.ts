import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    clipboard: {
      type: "select",
      label: "Clipboard mirroring",
      description:
        "Which register writes also go to the OS clipboard. `p` reads the clipboard when the last write was mirrored. <Space>y always copies.",
      options: ["yank", "all", "never"],
      experimental_optionLabels: { yank: "Yanks only", all: "Yanks and deletes", never: "Never" },
      default: "yank",
    },
    readlineKeys: {
      type: "boolean",
      label: "Readline keys in Insert mode",
      description: "Ctrl+W/U/K/A/E/B/F/D/H/Y, Ctrl+Q, and Alt+B/F/D, matching Pi's editor.",
      default: true,
    },
    autoPairs: {
      type: "boolean",
      label: "Auto-pair brackets and quotes in Insert mode",
      description: "mini.pairs-style pairing for ( [ { \" `.",
      default: false,
    },
    showModeIndicator: {
      type: "boolean",
      label: "Show the mode indicator in the composer",
      default: true,
    },
  });

  bb.http.route("GET", "/settings", async (context) => context.json(await settings.get()));

  bb.log.info("loaded");
}
