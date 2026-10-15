# Composer Vim for bb

Neovim-style modal editing in bb's chat composer, with Pi's readline keys in Insert mode.

The plugin drives bb's ProseMirror editor through transactions, so mention pills, attachments, paste, voice input, and submit stay native. Edits never touch the DOM directly.

## Install

```sh
npm install
bb plugin install .
```

During development, `bb plugin dev` rebuilds and reloads on save. `npm test` runs the engine tests.

## Behavior

- The composer starts in Insert mode whenever it gains focus and after a prompt is sent.
- `Esc` in Insert goes to Normal. `Esc` in Normal clears search highlighting if any, otherwise goes to bb (which blurs the composer).
- `Enter` submits in every mode. `Shift+Enter` inserts a newline. `Cmd` shortcuts always go to bb.
- In Normal mode, Ctrl/Alt chords the plugin doesn't use go to bb. Unused plain keys are ignored.
- The mode label sits next to the voice button. Normal and Visual modes show a block cursor.

## Keys

### Insert mode

| Keys | Action |
| --- | --- |
| `Esc`, `Ctrl+[`, `Ctrl+C` | Normal mode |
| `Ctrl+W`, `Alt+Backspace` | Delete word before cursor |
| `Ctrl+U` / `Ctrl+K` | Delete to line start / end |
| `Ctrl+A` / `Ctrl+E` | Line start / end |
| `Ctrl+B` / `Ctrl+F`, `Alt+B` / `Alt+F` | Character / word left and right |
| `Ctrl+D` / `Ctrl+H` | Delete character forward / back |
| `Alt+D` | Delete word forward |
| `Ctrl+Y` | Paste the last Ctrl+W/U/K/Alt+D kill |
| `Ctrl+Q` | Delete previous WORD and the space before it (your nvim `<C-q>`) |
| `Ctrl+O` | Run one Normal-mode command |
| `Ctrl+R {reg}` | Insert a register |
| `Alt+O` / `Alt+Shift+O` | Open line below / above |
| `Alt+Shift+A` / `Alt+Shift+I` | Line end / first non-blank |

The readline keys can be turned off in settings.

### Normal mode

- Motions: `h j k l`, `w W b B e E ge gE`, `0 ^ $ _ -`, `gh` / `gl` (your `^` / `$` maps, also after operators), `gg G`, `{ }`, `%`, `f F t T ; ,`, `/ ? n N * #`. Counts work.
- `j` / `k` without a count move by wrapped display line (your `gj` / `gk` maps). `gj` / `gk` also work.
- Operators: `d c y`, `g~ gu gU`, `<Space>y` (system clipboard), `sa` (surround add). Doubled forms like `dd`, `cc`, `yy`, `guu` act on lines.
- Text objects: `iw aw iW aW`, `ip ap`, quotes `" ' \``, brackets `( [ { <` and aliases, plus mini.ai's `q` (any quote), `b` (any bracket), `a` (argument), and `f` (function call). Brackets and quotes search forward when the cursor isn't inside one.
- Editing: `x X s S D C Y` (`Y` is `y$`), `r{c}`, `J gJ`, `~`, `p P`, `>` / `<` (indent the line, your single-key maps), `.`, `u`, `Ctrl+R`.
- Insert: `i a I A o O`.
- Registers: `"{a-z}` (uppercase appends), `"+` / `"*` clipboard, `"0` last yank, `"_` black hole.
- Surround (mini.surround): `sa{motion}{char}`, `sd{char}`, `sr{old}{new}`. `(`, `[`, `{`, `<` add inner spaces; `)`, `]`, `}`, `>`, `b` don't. A lone `s` substitutes after 300 ms or when the next key isn't `a`, `d`, or `r`.
- Move lines (mini.move): `Alt+J` / `Alt+K` move the line; `Alt+H` / `Alt+L` dedent / indent.
- `+` highlights the word under the cursor without moving (your `*N` map).
- `Ctrl+D` / `Ctrl+U` scroll the thread half a page; `Ctrl+E` / `Ctrl+Y` scroll a few lines.

### Visual and Visual Line modes

`v`, `V`, `gv`, `o`. Motions and text objects extend the selection. `d x y c s`, `D X Y C S` (whole lines), `p P` (replace selection), `~ u U`, `J gJ`, `r{c}`, `I A`, `<Space>y`, `sa{char}`. `>` and `<` keep the selection (your `>gv` maps). `Alt+J` / `Alt+K` move the selected lines.

## Clipboard

With the default `yank` setting, yanks copy to the OS clipboard and deletes stay in the unnamed register, matching your Pi `clipboardMirror: "yank"`. `p` reads the OS clipboard when the last register write was copied there and the clipboard has since changed; otherwise it uses the register, which keeps mention pills.

## Not supported

Macros, marks, `:` commands, Replace mode (`R`), Visual Block, sentence and tag text objects, and an undo tree. Undo is linear: one `u` reverts one Normal-mode change or one whole Insert session.

## Layout

- `src/engine.ts`: the Vim state machine over flat text (`src/text.ts` holds motion helpers). No DOM.
- `src/pm-host.ts`: maps flat offsets to ProseMirror positions and applies edits as transactions.
- `src/controller.ts`: content script that attaches to composers, routes keys, and draws the block cursor.
- `app.tsx` / `server.ts`: plugin entries, settings, and the mode label.
