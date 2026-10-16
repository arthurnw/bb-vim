import { describe, expect, it } from "vitest";
import { VimEngine } from "../src/engine";
import { DEFAULT_OPTIONS, type EngineOptions } from "../src/host";
import { ATOM } from "../src/text";
import { MemoryHost } from "./memory-host";

function tokens(seq: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] === "<") {
      const j = seq.indexOf(">", i);
      if (j > i + 1) {
        out.push(seq.slice(i, j + 1));
        i = j;
        continue;
      }
    }
    out.push(seq[i] === " " ? "<Space>" : seq[i]);
  }
  return out;
}

function setup(marked: string, options: Partial<EngineOptions> = {}) {
  const pos = marked.indexOf("|");
  const host = new MemoryHost(marked.replace("|", ""), pos);
  const engine = new VimEngine(host, { ...DEFAULT_OPTIONS, ...options });
  engine.handleKey("<Esc>");
  host.setCursor(pos);
  const press = async (seq: string) => {
    for (const k of tokens(seq)) await engine.handleKey(k);
  };
  /** Type text the way native Insert mode would. */
  const type = (s: string) => {
    const c = host.head;
    host.replace(c, c, s, [], c + s.length);
  };
  const show = () => host.value.slice(0, host.head) + "|" + host.value.slice(host.head);
  return { host, engine, press, type, show };
}

describe("motions", () => {
  it("moves by words and WORDs", async () => {
    const v = setup("|foo-bar baz");
    await v.press("w");
    expect(v.show()).toBe("foo|-bar baz");
    await v.press("W");
    expect(v.show()).toBe("foo-bar |baz");
    await v.press("B");
    expect(v.show()).toBe("|foo-bar baz");
    await v.press("e");
    expect(v.show()).toBe("fo|o-bar baz");
  });

  it("supports gh/gl as ^/$ and counts", async () => {
    const v = setup("  he|llo world\nnext");
    await v.press("gh");
    expect(v.show()).toBe("  |hello world\nnext");
    await v.press("gl");
    expect(v.show()).toBe("  hello worl|d\nnext");
    await v.press("j");
    expect(v.show()).toBe("  hello world\nnex|t");
    await v.press("gg");
    expect(v.show()).toBe("  |hello world\nnext");
  });

  it("finds characters and repeats", async () => {
    const v = setup("|a,b,c,d");
    await v.press("f,");
    expect(v.show()).toBe("a|,b,c,d");
    await v.press(";");
    expect(v.show()).toBe("a,b|,c,d");
    await v.press(",");
    expect(v.show()).toBe("a|,b,c,d");
    await v.press("t,");
    expect(v.show()).toBe("a,|b,c,d");
  });

  it("matches brackets with %", async () => {
    const v = setup("|f(a(b)c)");
    await v.press("%");
    expect(v.show()).toBe("f(a(b)c|)");
  });
  it("G goes to the end of the input; counts and operators stay linewise", async () => {
    const v = setup("|  first line\n  a long wrapped prompt");
    await v.press("G");
    expect(v.show()).toBe("  first line\n  a long wrapped promp|t");
    await v.press("1G");
    expect(v.show()).toBe("  |first line\n  a long wrapped prompt");
    await v.press("dG");
    expect(v.host.value).toBe("");
  });
});

describe("operators", () => {
  it("deletes words, lines, and to line end", async () => {
    const v = setup("|one two three\nfour");
    await v.press("dw");
    expect(v.show()).toBe("|two three\nfour");
    await v.press("dd");
    expect(v.show()).toBe("|four");
    await v.press("u");
    expect(v.host.value).toBe("two three\nfour");
    await v.press("u");
    expect(v.host.value).toBe("one two three\nfour");
    await v.press("<C-r>");
    expect(v.host.value).toBe("two three\nfour");
  });

  it("dw at the last word stops at line end", async () => {
    const v = setup("a |bc\nde");
    await v.press("dw");
    expect(v.show()).toBe("a| \nde");
  });

  it("changes inside quotes and brackets (mini.ai cover-or-next)", async () => {
    const v = setup('say |"hello" (x)');
    await v.press('ci"');
    v.type("bye");
    await v.press("<Esc>");
    expect(v.host.value).toBe('say "bye" (x)');
    v.host.setCursor(0);
    await v.press("cib");
    v.type("y");
    await v.press("<Esc>");
    expect(v.host.value).toBe('say "bye" (y)');
    v.host.setCursor(0);
    await v.press("diq");
    expect(v.host.value).toBe('say "" (y)');
  });

  it("cw acts like ce", async () => {
    const v = setup("|foo bar");
    await v.press("cw");
    v.type("baz");
    await v.press("<Esc>");
    expect(v.show()).toBe("ba|z bar");
  });

  it("supports argument and function-call text objects", async () => {
    const v = setup("call(a, |bb, c)");
    await v.press("daa");
    expect(v.host.value).toBe("call(a, c)");
    v.host.setCursor(6);
    await v.press("cif");
    v.type("z");
    await v.press("<Esc>");
    expect(v.host.value).toBe("call(z)");
    await v.press("daf");
    expect(v.host.value).toBe("");
  });

  it("yanks, puts, and keeps linewise registers", async () => {
    const v = setup("|line one\nline two");
    await v.press("yyp");
    expect(v.host.value).toBe("line one\nline one\nline two");
    expect(v.host.clipboard).toBe("line one\n");
    await v.press("yiw");
    await v.press("P");
    expect(v.host.value).toBe("line one\nlinelineone\nline two".replace("linelineone", "lineline one"));
  });

  it("deletes do not mirror to the clipboard under the yank policy", async () => {
    const v = setup("|abc def");
    v.host.clipboard = "external";
    await v.press("dw");
    expect(v.host.clipboard).toBe("external");
    await v.press("$p");
    expect(v.host.value).toBe("defabc ");
  });

  it("pastes the OS clipboard when it changed after a yank", async () => {
    const v = setup("|abc");
    await v.press("yl");
    v.host.clipboard = "XYZ";
    await v.press("p");
    expect(v.host.value).toBe("aXYZbc");
  });

  it("<leader>y always writes the clipboard", async () => {
    const v = setup("|abc def", { clipboard: "never" });
    await v.press("yw");
    expect(v.host.clipboard).toBe(null);
    await v.press(" yiw");
    expect(v.host.clipboard).toBe("abc");
  });

  it("changes case with g~, gU, gu and ~", async () => {
    const v = setup("|hello World");
    await v.press("gUiw");
    expect(v.host.value).toBe("HELLO World");
    await v.press("w~");
    expect(v.host.value).toBe("HELLO world");
    await v.press("guu");
    expect(v.host.value).toBe("hello world");
  });

  it("joins lines and indents", async () => {
    const v = setup("|a\n   b\nc");
    await v.press("J");
    expect(v.show()).toBe("a| b\nc");
    await v.press(">");
    expect(v.host.value).toBe("  a b\nc");
    await v.press("<");
    expect(v.host.value).toBe("a b\nc");
  });

  it("repeats changes with .", async () => {
    const v = setup("|a b c d");
    await v.press("dw");
    await v.press(".");
    expect(v.host.value).toBe("c d");
    await v.press("ciw");
    v.type("X");
    await v.press("<Esc>w.");
    expect(v.host.value).toBe("X X");
  });

  it("keeps mention atoms through edits and puts", async () => {
    const v = setup(`|see ${ATOM} now`);
    v.host.atoms = ["@thread:1"];
    await v.press("yy");
    expect(v.host.clipboard).toBe("see @thread:1 now\n");
    await v.press("p");
    expect(v.host.atoms).toEqual(["@thread:1", "@thread:1"]);
    await v.press("dd");
    expect(v.host.atoms).toEqual(["@thread:1"]);
  });
});

describe("surround (mini.surround)", () => {
  it("adds, deletes, and replaces", async () => {
    const v = setup("say |hello");
    await v.press("saiw)");
    expect(v.host.value).toBe("say (hello)");
    await v.press("sr)]");
    expect(v.host.value).toBe("say [hello]");
    await v.press("sd]");
    expect(v.host.value).toBe("say hello");
    await v.press('saiw"');
    expect(v.host.value).toBe('say "hello"');
  });

  it("a lone s substitutes after the timeout or another key", async () => {
    const v = setup("|abc");
    await v.press("s");
    v.engine.flushTimers();
    expect(v.engine.mode).toBe("insert");
    expect(v.host.value).toBe("bc");
    await v.press("<Esc>");
    v.host.setCursor(0);
    await v.press("sx");
    expect(v.host.value).toBe("xc");
    expect(v.engine.mode).toBe("insert");
  });
});

describe("visual mode", () => {
  it("selects with motions and deletes", async () => {
    const v = setup("|hello world");
    await v.press("vey");
    expect(v.host.clipboard).toBe("hello");
    await v.press("wviwd");
    expect(v.host.value).toBe("hello ");
  });

  it("linewise indent keeps the selection", async () => {
    const v = setup("|a\nb\nc");
    await v.press("Vj>");
    expect(v.host.value).toBe("  a\n  b\nc");
    expect(v.engine.mode).toBe("vline");
    await v.press("<Esc>");
    expect(v.engine.mode).toBe("normal");
  });

  it("moves lines with alt+j/k (mini.move)", async () => {
    const v = setup("|a\nb\nc");
    await v.press("<A-j>");
    expect(v.host.value).toBe("b\na\nc");
    await v.press("Vj<A-k>");
    expect(v.host.value).toBe("a\nc\nb".replace("a\nc\nb", "a\nc\nb"));
  });
});

describe("insert mode", () => {
  it("handles readline keys from pi", async () => {
    const v = setup("");
    await v.press("i");
    v.type("hello big world");
    await v.press("<C-w>");
    expect(v.show()).toBe("hello big |");
    await v.press("<C-a>");
    expect(v.show()).toBe("|hello big ");
    await v.press("<C-k>");
    expect(v.host.value).toBe("");
    await v.press("<C-y>");
    expect(v.host.value).toBe("hello big ");
    await v.press("<C-u>");
    expect(v.host.value).toBe("");
  });

  it("ctrl+q deletes the previous WORD and the char before it", async () => {
    const v = setup("");
    await v.press("i");
    v.type("one foo-bar");
    await v.press("<C-q>");
    expect(v.show()).toBe("one|");
  });

  it("ctrl+o runs one Normal command", async () => {
    const v = setup("");
    await v.press("i");
    v.type("abc def");
    await v.press("<C-o>0");
    expect(v.engine.mode).toBe("insert");
    expect(v.show()).toBe("|abc def");
  });

  it("escape moves the cursor left like Vim", async () => {
    const v = setup("|");
    await v.press("i");
    v.type("abc");
    await v.press("<Esc>");
    expect(v.show()).toBe("ab|c");
    await v.press("u");
    expect(v.host.value).toBe("");
  });

  it("auto-pairs when enabled", async () => {
    const v = setup("", { autoPairs: true });
    await v.press("i(");
    expect(v.show()).toBe("(|)");
    await v.press(")");
    expect(v.show()).toBe("()|");
  });
});

describe("search", () => {
  it("searches with smartcase and repeats", async () => {
    const v = setup("|foo Foo foo");
    await v.press("/foo<CR>");
    expect(v.show()).toBe("foo |Foo foo");
    await v.press("n");
    expect(v.show()).toBe("foo Foo |foo");
    await v.press("/Foo<CR>");
    expect(v.show()).toBe("foo |Foo foo");
    await v.press("<Esc>");
    expect(v.host.highlight).toBe(null);
  });

  it("+ highlights the word without moving", async () => {
    const v = setup("|foo bar foo");
    await v.press("+");
    expect(v.show()).toBe("|foo bar foo");
    expect(v.host.highlight?.length).toBe(2);
    await v.press("n");
    expect(v.show()).toBe("foo bar |foo");
  });
});

describe("bb pass-through", () => {
  it("leaves Enter and unknown ctrl chords to bb", () => {
    const v = setup("|abc");
    expect(v.engine.handleKey("<CR>")).toBe(false);
    expect(v.engine.handleKey("<C-p>")).toBe(false);
    expect(v.engine.handleKey("<Esc>")).toBe(false);
    expect(v.engine.handleKey("Q")).toBe(true);
  });
});
