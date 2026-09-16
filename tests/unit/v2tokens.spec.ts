import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Graphite restyles the existing v2 primitives through stable semantic
 * tokens. Check the approved palette, aliases and radii while retaining
 * the primitives' typography, motion and source-level acceptance rules:
 * component colors come from tokens, state accents remain scoped, and
 * nothing is set under 11px.
 */
const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
const decl = (name: string) => {
  const m = css.match(new RegExp(`(?:^|[\\s{;])${name.replace(/-/g, "\\-")}:\\s*([^;]+);`, "m"));
  return m?.[1].trim();
};

test("Graphite palette and stable primitive token aliases", () => {
  const want: Record<string, string> = {
    "--graphite-ground": "#000000",
    "--graphite-panel": "#0d0d10",
    "--graphite-card": "#17171b",
    "--graphite-control": "#1b1b1f",
    "--graphite-ink": "#f5f5f7",
    "--graphite-body": "rgba(235, 235, 245, .6)",
    "--graphite-muted": "rgba(235, 235, 245, .5)",
    "--graphite-line": "rgba(255, 255, 255, .10)",
    "--graphite-edge": "rgba(255, 255, 255, .16)",
    "--graphite-selected": "#3a3a40",
    "--graphite-accent": "#0a84ff",
    "--graphite-on-primary": "#ffffff",
    "--ground": "var(--graphite-ground)",
    "--card": "var(--graphite-card)",
    "--card-raised": "var(--graphite-control)",
    "--ink": "var(--graphite-ink)",
    "--ink-body": "var(--graphite-body)",
    "--ink-muted": "var(--graphite-muted)",
    "--hairline": "rgba(255, 255, 255, .08)",
    "--border": "var(--graphite-line)",
    "--selected": "var(--graphite-selected)",
    "--accent": "var(--graphite-accent)",
    "--on-primary-cost": "var(--graphite-on-primary)",
    "--placeholder": "repeating-linear-gradient(135deg,#1A1D24 0 6px,#20242B 6px 12px)",
    "--waveform": "repeating-linear-gradient(90deg,rgba(110,180,255,.5) 0 2px,transparent 2px 5px)",
  };
  for (const [name, value] of Object.entries(want)) expect(decl(name), name).toBe(value);
  // Keep the existing edge token names mapped to Graphite's stronger edges.
  expect(decl("--border-mid")).toBe("var(--graphite-edge)");
  expect(decl("--border-hover")).toBe("rgba(255, 255, 255, .28)");
});

test("each token is a Tailwind utility too, as an alias — never a second value", () => {
  for (const t of ["ground", "card", "card-raised", "ink", "ink-body", "ink-muted", "hairline", "border", "border-mid", "border-hover", "selected", "accent", "on-primary-cost"]) {
    expect(decl(`--color-${t}`), `--color-${t}`).toBe(`var(--${t})`);
  }
  // Primitive surfaces still avoid duplicate semantic token names.
  for (const extra of ["--color-rail", "--color-chip-scrim", "--color-sheet-scrim", "--ring-selected"]) {
    expect(css.includes(`${extra}:`), `${extra} is not a token`).toBe(false);
  }
});

test("Graphite radii and selection preserve primitive typography and motion", () => {
  for (const [name, px] of [["badge", 4], ["chip", 6], ["ctl", 6], ["tile", 8], ["card", 8], ["mobile", 12], ["pill", 999]] as const) {
    expect(css, `--radius-${name}`).toMatch(new RegExp(`--radius-${name}:\\s*${px}px;`));
  }
  expect(css).toMatch(/\.ui-node-selected\s*\{\s*border-color:\s*var\(--graphite-accent\);\s*box-shadow:\s*0 0 0 3px rgba\(10,132,255,\.22\);/);
  expect(css).toMatch(/\.ui-h1\s*\{\s*font:\s*600 32px\/1\.05 var\(--font-sans\);\s*letter-spacing:\s*-0\.025em/);
  expect(css).toMatch(/\.ui-mono\s*\{\s*font:\s*500 11px\/1 var\(--font-mono\);\s*text-transform:\s*uppercase;\s*letter-spacing:\s*\.12em/);
  expect(css).toMatch(/\.ui-mono-cost\s*\{\s*letter-spacing:\s*\.08em;/);
  expect(css).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.ui-mono\s*\{\s*font-size:\s*12px;/);   // mobile is below 768 (§14)
  expect(css).not.toMatch(/prefers-reduced-motion[^}]*atomik/);   // no rule the handoff does not have
  expect(css).toMatch(/@keyframes atomikPulse\s*\{\s*0%,\s*100%\s*\{\s*opacity:\s*\.22\s*\}\s*18%\s*\{\s*opacity:\s*1\s*\}\s*55%\s*\{\s*opacity:\s*\.22\s*\}\s*\}/);
  expect(css).toMatch(/\.atomik-pulse\s*\{\s*animation:\s*atomikPulse 1\.6s cubic-bezier\(\.4,\s*0,\s*\.2,\s*1\) infinite;/);
  expect(css).toMatch(/@keyframes atomikBar\s*\{\s*0%\s*\{\s*width:\s*12%\s*\}\s*50%\s*\{\s*width:\s*64%\s*\}\s*100%\s*\{\s*width:\s*12%\s*\}\s*\}/);
  // The rail uses Graphite; existing media and sheet scrims stay unchanged.
  expect(css).toMatch(/\.ui-rail\s*\{\s*background:\s*var\(--graphite-panel\);/);
  expect(css).toMatch(/\.ui-chip-scrim\s*\{\s*background:\s*rgba\(11,13,17,\.85\);/);
  expect(css).toMatch(/\.ui-sheet-scrim\s*\{\s*background:\s*rgba\(5,6,8,\.55\);/);
});

/** Every file the v2 primitives are made of. */
function v2Sources(): { file: string; text: string }[] {
  const root = join(__dirname, "../..");
  const files = [
    ...readdirSync(join(root, "components/ui")).map((f) => `components/ui/${f}`),
    "components/atomik/Ring.tsx", "components/atomik/Loader.tsx", "lib/ring.ts",
  ];
  return files.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

test("§16: the primitives paint by token — no literal colour, and the accent only where allowed", () => {
  for (const { file, text } of v2Sources()) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* No hex, no oklch, no hsl in the components: colour comes from the
       theme. (An ink alpha the boards use and the theme does not name —
       .1, .16, .3 — is written as the board writes it.) */
    const literal = code.match(/#[0-9a-f]{3,8}\b|oklch\(|hsl\(/gi) ?? [];
    expect(literal, `${file} paints by token`).toEqual([]);
    /* The accent may be named only by the state dot (approved/done/running
       and the word beside it), the ring (running/checkpoint/done) and the
       paint table that serves it. Everywhere else, `accent` in the source
       is a bug. */
    const allowed = ["components/ui/StateDot.tsx", "components/atomik/Ring.tsx", "lib/ring.ts", "components/ui/index.ts"];
    if (!allowed.includes(file)) {
      expect(code.includes("accent"), `${file} does not use the accent`).toBe(false);
    }
  }
});

test("§16: nothing under 11px", () => {
  for (const { file, text } of v2Sources()) {
    for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)px\]|font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      const px = Number(m[1] ?? m[2]);
      expect(px, `${file}: ${m[0]}`).toBeGreaterThanOrEqual(11);
    }
  }
  /* Only the classes this design owns: `ui-*` and the ring's two. The
     older `atomik-*` classes belong to the /atomik route and leave with
     it (§0, step 3). */
  for (const m of css.matchAll(/\.(?:ui-[\w-]*|atomik-pulse|atomik-bar)\s*\{[^}]*font(?:-size)?:\s*(?:\d{3}\s+)?(\d+(?:\.\d+)?)px/g)) {
    expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(11);
  }
});

test("the loader never uses the accent and never spins", () => {
  const loader = readFileSync(join(__dirname, "../../components/atomik/Loader.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");   // the comment is allowed to say "never the accent"
  expect(loader).not.toMatch(/accent/);
  expect(loader).not.toMatch(/rotate|spin/i);
  expect(css).not.toMatch(/\.atomik-pulse[^}]*transform/);
});
