import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Graphite is one token set: app/graphite.css, at the values of
 * design/particl-graphite/README.md § Design tokens. Every older name
 * (`--graphite-*`, and the `--color-*` utilities in globals.css) is an alias
 * of it with no value of its own. globals.css is flat and dark: no blur, no
 * gradient, no light theme. The v2 primitives still paint by token and set
 * nothing under 11px.
 */
const root = join(__dirname, "../..");
const tokens = readFileSync(join(root, "app/graphite.css"), "utf8");
const css = readFileSync(join(root, "app/globals.css"), "utf8");
const uncomment = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** A declaration's value, compared without whitespace or case, with `0.6` and `.6` the same. */
const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase().replace(/(^|[^\d])0\./g, "$1.").replace(/\.(\d*?)0+(?=[^\d]|$)/g, (_m, d) => (d ? `.${d}` : ""));
const declIn = (text: string, name: string) => {
  const m = uncomment(text).match(new RegExp(`(?:^|[\\s{;])${name}:\\s*([^;]+);`, "m"));
  return m?.[1].trim();
};

test("the Graphite colour tokens are the README's values", () => {
  const want: Record<string, string> = {
    // surfaces
    "--gx-root": "#000000",
    "--gx-panel": "#0D0D10",
    "--gx-card": "#17171B",
    "--gx-input": "#1B1B1F",
    "--gx-input-hover": "#26262B",
    "--gx-thumb": "#3A3A40",
    "--gx-track": "#1C1C20",
    "--gx-viewport": "#07070A",
    // hairlines
    "--gx-hair-soft": "rgba(255,255,255,0.06)",
    "--gx-hair": "rgba(255,255,255,0.08)",
    "--gx-hair-strong": "rgba(255,255,255,0.09)",
    "--gx-card-border": "rgba(255,255,255,0.10)",
    "--gx-pop-border": "rgba(255,255,255,0.12)",
    "--gx-dialog-border": "rgba(255,255,255,0.14)",
    "--gx-dashed": "rgba(255,255,255,0.16)",
    "--gx-hover-border": "rgba(255,255,255,0.24)",
    // text
    "--gx-text": "#F5F5F7",
    "--gx-text-2": "rgba(235,235,245,0.6)",
    "--gx-text-half": "rgba(235,235,245,0.5)",
    "--gx-text-3": "rgba(235,235,245,0.45)",
    "--gx-eyebrow": "rgba(235,235,245,0.4)",
    "--gx-idle": "rgba(235,235,245,0.35)",
    "--gx-placeholder": "rgba(235,235,245,0.35)",
    // accent and its tints
    "--gx-accent": "#0A84FF",
    "--gx-accent-hover": "#2D95FF",
    "--gx-accent-text": "#6EB4FF",
    "--gx-accent-text-hover": "#8FC4FF",
    "--gx-tint": "rgba(10,132,255,0.14)",
    "--gx-tint-12": "rgba(10,132,255,0.12)",
    "--gx-tint-10": "rgba(10,132,255,0.10)",
    "--gx-tint-08": "rgba(10,132,255,0.08)",
    "--gx-tint-border": "rgba(10,132,255,0.35)",
    "--gx-tint-border-45": "rgba(10,132,255,0.45)",
    "--gx-tint-border-50": "rgba(10,132,255,0.5)",
    "--gx-on-accent-badge": "rgba(255,255,255,0.14)",
    // state and lanes
    "--gx-done": "#30D158",
    "--gx-done-text": "#4CD964",
    "--gx-done-tint": "rgba(48,209,88,0.14)",
    "--gx-waiting": "#FF9F0A",
    "--gx-waiting-text": "#FFB340",
    "--gx-failed": "#FF453A",
    "--gx-purple": "#BF5AF2",
    "--gx-cyan": "#64D2FF",
    // suite dots
    "--gx-suite-studio": "#0A84FF",
    "--gx-suite-business": "#FF9F0A",
    "--gx-suite-viral": "#FF453A",
    "--gx-suite-atomik": "#30D158",
    "--gx-suite-crew": "#BF5AF2",
    // on media, behind overlays
    "--gx-on-media": "rgba(0,0,0,0.6)",
    "--gx-scrim": "rgba(0,0,0,0.55)",
  };
  for (const [name, value] of Object.entries(want)) {
    const got = declIn(tokens, name);
    expect(got, `${name} is declared`).toBeTruthy();
    expect(norm(got!), name).toBe(norm(value));
  }
  expect(uncomment(tokens)).toMatch(/color-scheme:\s*dark;/);
  expect(uncomment(tokens)).not.toMatch(/color-scheme:\s*light/);
});

test("radii, shadows and easing are the README's", () => {
  const want: Record<string, string> = {
    "--gx-r-panel": "0",
    "--gx-r-card": "8px",
    "--gx-r-dialog": "10px",
    "--gx-r-ctl": "6px",
    "--gx-r-sm": "5px",
    "--gx-r-xs": "4px",
    "--gx-r-pill": "999px",
    "--gx-shadow-pop": "0 16px 40px rgba(0,0,0,0.6)",
    "--gx-shadow-dialog": "0 32px 80px rgba(0,0,0,0.7)",
    "--gx-shadow-toast": "0 12px 32px rgba(0,0,0,0.6)",
    "--gx-shadow-search": "inset 0 1px 2px rgba(0,0,0,0.6)",
    "--gx-shadow-node": "0 1px 0 rgba(0,0,0,0.4)",
    "--gx-ring-selected": "0 0 0 2px #0A84FF, 0 0 0 5px rgba(10,132,255,0.22)",
    "--gx-glow-port": "0 0 0 4px rgba(10,132,255,0.35)",
    "--gx-glow-live": "0 0 8px rgba(10,132,255,0.8)",
    "--gx-ease": "cubic-bezier(.2,.7,.2,1)",
  };
  for (const [name, value] of Object.entries(want)) {
    const got = declIn(tokens, name);
    expect(got, `${name} is declared`).toBeTruthy();
    expect(norm(got!), name).toBe(norm(value));
  }
});

test("every older --graphite-* name is an alias, never a second value", () => {
  const decls = [...uncomment(tokens).matchAll(/(--graphite-[\w-]+):\s*([^;]+);/g)];
  expect(decls.length).toBeGreaterThan(0);
  for (const [, name, value] of decls) {
    expect(value.trim(), name).toMatch(/^var\(--gx-[\w-]+\)$/);
  }
  // …and globals.css does not declare them again.
  expect(uncomment(css)).not.toMatch(/--graphite-[\w-]+\s*:/);
  expect(uncomment(css)).not.toMatch(/--gx-[\w-]+\s*:/);
});

test("globals.css @theme and :root carry aliases only — no literal colour", () => {
  const code = uncomment(css);
  const theme = code.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const colours = [...theme.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)];
  expect(colours.length).toBeGreaterThan(30);
  for (const [, name, value] of colours) {
    expect(value.trim(), name).toMatch(/^var\(--[\w-]+\)$/);
  }
  for (const t of ["ground", "card", "card-raised", "ink", "ink-body", "ink-muted", "hairline", "border", "border-mid", "border-hover", "selected", "accent", "on-primary-cost"]) {
    expect(declIn(css, `--color-${t}`), `--color-${t}`).toBe(`var(--${t})`);
  }
  const alias: Record<string, string> = {
    "--ground": "var(--graphite-ground)",
    "--card": "var(--graphite-card)",
    "--card-raised": "var(--graphite-control)",
    "--ink": "var(--graphite-ink)",
    "--ink-body": "var(--graphite-body)",
    "--ink-muted": "var(--graphite-muted)",
    "--hairline": "var(--gx-hair)",
    "--border": "var(--graphite-line)",
    "--border-mid": "var(--graphite-edge)",
    "--border-hover": "var(--gx-hover-border)",
    "--selected": "var(--graphite-selected)",
    "--accent": "var(--graphite-accent)",
    "--on-primary-cost": "var(--graphite-on-primary)",
    "--placeholder": "var(--gx-input)",
    "--placeholder-fine": "var(--gx-input)",
  };
  for (const [name, value] of Object.entries(alias)) expect(declIn(css, name), name).toBe(value);
  // Primitive surfaces still avoid duplicate semantic token names.
  for (const extra of ["--color-rail", "--color-chip-scrim", "--color-sheet-scrim", "--ring-selected"]) {
    expect(code.includes(`${extra}:`), `${extra} is not a token`).toBe(false);
  }
  // No colour of its own anywhere in the sheet. A data-URI image (the
  // waveform, the select caret) is an image, not a declared colour.
  const noImages = code.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, "url()");
  expect(noImages.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/gi) ?? []).toEqual([]);
});

test("globals.css is flat and dark: no blur, no gradient, no light theme", () => {
  const code = uncomment(css);
  expect(code).not.toMatch(/backdrop-filter/);
  expect(code).not.toMatch(/filter:\s*blur/);
  expect(code).not.toMatch(/gradient\(/);
  expect(code).not.toMatch(/\.theme-light/);
  expect(code).not.toMatch(/\.theme-dark/);
  expect(code).not.toMatch(/color-scheme:\s*light/);
  expect(code).not.toMatch(/mask-image/);
});

test("Graphite radii and selection preserve primitive typography and motion", () => {
  for (const [name, value] of [["badge", "var(--gx-r-xs)"], ["chip", "var(--gx-r-ctl)"], ["ctl", "var(--gx-r-ctl)"], ["tile", "var(--gx-r-card)"], ["card", "var(--gx-r-card)"], ["mobile", "12px"], ["pill", "var(--gx-r-pill)"]] as const) {
    expect(declIn(css, `--radius-${name}`), `--radius-${name}`).toBe(value);
  }
  expect(css).toMatch(/\.ui-node-selected\s*\{\s*border-color:\s*var\(--graphite-accent\);\s*box-shadow:\s*var\(--gx-ring-selected\);/);
  expect(css).toMatch(/\.ui-h1\s*\{\s*font:\s*600 32px\/1\.05 var\(--font-sans\);\s*letter-spacing:\s*-0\.025em/);
  expect(css).toMatch(/\.ui-mono\s*\{\s*font:\s*500 11px\/1 var\(--font-mono\);\s*text-transform:\s*uppercase;\s*letter-spacing:\s*\.12em/);
  expect(css).toMatch(/\.ui-mono-cost\s*\{\s*letter-spacing:\s*\.08em;/);
  expect(css).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.ui-mono\s*\{\s*font-size:\s*12px;/);   // mobile is below 768 (§14)
  expect(css).not.toMatch(/prefers-reduced-motion[^}]*atomik/);   // no rule the handoff does not have
  expect(css).toMatch(/@keyframes atomikPulse\s*\{\s*0%,\s*100%\s*\{\s*opacity:\s*\.22\s*\}\s*18%\s*\{\s*opacity:\s*1\s*\}\s*55%\s*\{\s*opacity:\s*\.22\s*\}\s*\}/);
  expect(css).toMatch(/\.atomik-pulse\s*\{\s*animation:\s*atomikPulse 1\.6s cubic-bezier\(\.4,\s*0,\s*\.2,\s*1\) infinite;/);
  expect(css).toMatch(/@keyframes atomikBar\s*\{\s*0%\s*\{\s*width:\s*12%\s*\}\s*50%\s*\{\s*width:\s*64%\s*\}\s*100%\s*\{\s*width:\s*12%\s*\}\s*\}/);
  // The rail, the chip over media and the sheet scrim are tokens.
  expect(css).toMatch(/\.ui-rail\s*\{\s*background:\s*var\(--graphite-panel\);/);
  expect(css).toMatch(/\.ui-chip-scrim\s*\{\s*background:\s*var\(--gx-on-media\);/);
  expect(css).toMatch(/\.ui-sheet-scrim\s*\{\s*background:\s*var\(--gx-scrim\);/);
});

/** Every file the v2 primitives are made of. */
function v2Sources(): { file: string; text: string }[] {
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
       tokens. */
    const literal = code.match(/#[0-9a-f]{3,8}\b|oklch\(|hsl\(/gi) ?? [];
    expect(literal, `${file} paints by token`).toEqual([]);
    /* The components/ui primitives carry no rgb()/rgba(), no gradient and
       no blur either: an alpha is a Graphite token, not a literal. */
    if (file.startsWith("components/ui/")) {
      expect(code.match(/\brgba?\(|gradient\(|backdrop-|blur\(/gi) ?? [], `${file} is flat and tokenised`).toEqual([]);
    }
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
  const loader = readFileSync(join(root, "components/atomik/Loader.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");   // the comment is allowed to say "never the accent"
  expect(loader).not.toMatch(/accent/);
  expect(loader).not.toMatch(/rotate|spin/i);
  expect(css).not.toMatch(/\.atomik-pulse[^}]*transform/);
});
