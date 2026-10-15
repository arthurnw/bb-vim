---
name: composer-vim
description: Configure the Composer Vim plugin (Vim modes in the bb composer). Use when the user asks to change its clipboard behavior, readline insert keys, auto-pairs, or mode indicator.
---

# Composer Vim settings

Change settings with `bb plugin config composer-vim set <key> <value>`; show them with `bb plugin config composer-vim`. Open composers pick up changes on their next focus.

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `clipboard` | `yank`, `all`, `never` | `yank` | Which register writes also copy to the OS clipboard. `<Space>y` always copies. |
| `readlineKeys` | `true`, `false` | `true` | Ctrl+W/U/K/A/E/B/F/D/H/Y, Ctrl+Q, Alt+B/F/D in Insert mode. |
| `autoPairs` | `true`, `false` | `false` | Pair `( [ { " \`` while typing in Insert mode. |
| `showModeIndicator` | `true`, `false` | `true` | Mode label next to the voice button. |

To keep a plugin's editor out of Vim handling, add `data-composer-vim-ignore` to it or an ancestor.
