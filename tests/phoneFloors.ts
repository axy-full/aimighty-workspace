import { expect, type Page } from "@playwright/test";

/**
 * The phone's floors, once.
 *
 * 05-mobile calls four rules non-negotiable, and each of them "was a defect
 * before it was fixed": nothing below 12px, every target ≥ 44×44, the last row
 * of every scroller clears whatever is pinned below it, and no functional
 * label dimmer than `#7C7C84` (the brief's floor).
 *
 * Each phone spec used to carry its own copy of those checks, with its own
 * element list and its own exemptions — and that is exactly how a real failure
 * slipped through: the copy in the old phone Make spec
 * exempted only `.pxm-segment`, while the same control shipped as `.pxm-seg` in
 * the old phone pages spec, so a legitimately 40px-tall
 * segmented option inside a 44px control was reported as a broken target. One
 * helper, one exemption list, and every spec reads the same floor.
 *
 * Each check here is at least as strict as the strictest copy it replaces:
 * the widest element list (buttons, links, selects and fields, not buttons
 * alone), the widest set of pinned blocks, the widest set of candidate last
 * rows, and the 44px WIDTH floor applied to segmented options too — which only
 * the pages copy did.
 */

/* ── The one exemption ──────────────────────────────────────────────────── */

/**
 * The single exemption, and the only one: a segmented option may be 40px tall.
 *
 * 05-mobile, "Rules that are not negotiable": *"Segmented options may be 40px
 * tall inside a 44px control."* The option is the ink, not the target — it sits
 * inside `.pxm-segmented`, which is itself at least 44px tall (see
 * components/workspace/mobile/mobile.css `.pxm-segmented { min-height: 44px }`), so a thumb
 * aiming at an option lands inside a 44px row whichever pixel it hits. Both
 * class names exist because two waves shipped the same control: `.pxm-seg`
 * (the page-level segmented row) and `.pxm-segment` (Make, the Library sheet).
 * Neither is a licence to shrink: the exemption is only honoured when the
 * option really does sit inside a `.pxm-segmented` control that measures 44px
 * or more, and the 44px WIDTH floor still applies. Anything else that wants to
 * be under 44px is a defect, not a new entry in this list.
 */
/* `.gx-seg-btn` inside `.gx-seg` is the same control in the Suites shell
   (components/graphite/shell.css): a 40px option inside a track that is 44px or more. */
export const SEGMENTED_OPTION_CLASSES = ["pxm-seg", "pxm-segment", "gx-seg-btn"] as const;
export const SEGMENTED_CONTROL = ".pxm-segmented, .gx-seg";
export const SEGMENTED_OPTION_HEIGHT = 40;

/** Everything a thumb can hit — not buttons alone. */
const TARGETS = "button, a[href], select, input, textarea";
/** Everything the phone pins over a scroller. */
const PINNED = ['[data-testid="mobile-actions"]', '[data-testid="mobile-dock"]', ".pxm-composer-dock"];
/** Anything that can be the last row of a scroller in any template. */
const ROWS = "button, p, a, div[data-door], div[data-stem], div[data-node-id], div[data-rule], div[data-member]";

/* ── The four floors ────────────────────────────────────────────────────── */

/** Every visible text node with its computed size: the 12px floor. */
export async function smallText(page: Page, outside?: string): Promise<string[]> {
  return page.evaluate((outside) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || !el.getClientRects().length) continue;
      /* `outside` names a region measured by another spec (a hosted body). */
      if (outside && el.closest(outside)) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px: “${text.slice(0, 40)}” (${el.className || el.tagName})`);
    }
    return out;
  }, outside);
}

/**
 * Every visible target inside `scope` is at least 44×44, with the one
 * exemption above. `scope` defaults to the whole phone shell, which is the
 * widest any copy used; a spec may narrow it (the header alone, say) but
 * narrowing is the only thing it may do.
 */
export async function smallTargets(page: Page, scope = ".pxm-shell"): Promise<string[]> {
  return page.evaluate(
    ({ scope, TARGETS, classes, control, optionFloor }) => {
      /* `scope` may name several roots ("the page screen, the action bar and
         the dock"); every one of them is checked, not just the first. */
      const roots = Array.from(document.querySelectorAll<HTMLElement>(scope));
      if (!roots.length) return [`no ${scope}`];
      const targets = new Set<HTMLElement>();
      for (const root of roots) for (const el of Array.from(root.querySelectorAll<HTMLElement>(TARGETS))) targets.add(el);
      const out: string[] = [];
      for (const el of targets) {
        if (!el.getClientRects().length) continue;
        const rect = el.getBoundingClientRect();
        const name = `${el.dataset.testid || el.className || el.tagName}: ${Math.round(rect.width)}×${Math.round(rect.height)}`;
        const segmented = classes.some((c) => el.classList.contains(c));
        /* The exemption is earned, not claimed: the option must really sit
           inside a 44px segmented control. */
        const wrap = segmented ? el.closest<HTMLElement>(control) : null;
        const floor = wrap && wrap.getBoundingClientRect().height >= 44 - 0.5 ? optionFloor : 44;
        if (segmented && !wrap) out.push(`${name} — segmented option outside ${control}`);
        /* Half a pixel of layout rounding (a 44px button read as 43.99 on CI's
           Linux fonts) is not a smaller target; the same tolerance the
           segmented wrap already gets. The name prints the rounded size. */
        if (rect.width < 44 - 0.5 || rect.height < floor - 0.5) out.push(name);
      }
      return out;
    },
    { scope, TARGETS, classes: [...SEGMENTED_OPTION_CLASSES], control: SEGMENTED_CONTROL, optionFloor: SEGMENTED_OPTION_HEIGHT },
  );
}

/** At max scroll the last row is fully visible above whatever is pinned below. */
export async function lastRowClearsPinned(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ PINNED, ROWS }) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="mobile-scroll"]');
      if (!scroller) return ["no scroller"];
      scroller.scrollTop = scroller.scrollHeight;
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>(ROWS)).filter((el) => el.getClientRects().length);
      const last = rows[rows.length - 1];
      const problems: string[] = [];
      const box = scroller.getBoundingClientRect();
      if (last && last.getBoundingClientRect().bottom > box.bottom + 1)
        problems.push(`last row ends at ${last.getBoundingClientRect().bottom}, scroller ends at ${box.bottom}`);
      for (const sel of PINNED) {
        const block = document.querySelector<HTMLElement>(sel);
        if (!block) continue;
        const rect = block.getBoundingClientRect();
        if (box.bottom > rect.top + 1) problems.push(`scroller (${box.bottom}) runs under ${sel} (${rect.top})`);
      }
      return problems;
    },
    { PINNED, ROWS },
  );
}

/**
 * No functional label is dimmer than `#7C7C84` — the brief's floor for
 * kickers, column headers, nav numbers and counts, every one of which carries
 * `data-functional-label`.
 *
 * Measured as it lands on the screen, not as it is written: a colour with an
 * alpha (the Suites shell's `rgba(235, 235, 245, .45)` tertiary text) and any
 * opacity on the label or above it are composited over the ground behind the
 * label — every translucent background above it, laid over black, the darkest
 * ground a phone shows. Read by its RGB alone, a .45 white passed the floor it
 * falls well under.
 */
export async function dimLabels(page: Page, scope = ".pxm-shell"): Promise<string[]> {
  return page.evaluate(async (scope) => {
    /* At rest: an entrance still fading in (the shell's `gx-enter`) is not how the label reads. Loops (a pulse) are left as they are. */
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)));
    const roots = Array.from(document.querySelectorAll<HTMLElement>(scope));
    if (!roots.length) return [`no ${scope}`];
    const labels = new Set<HTMLElement>();
    for (const root of roots) for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-functional-label]"))) labels.add(el);
    type Rgba = { r: number; g: number; b: number; a: number };
    /* rgb()/rgba() in 0–255, or color(srgb …) in 0–1 (how Chromium writes a color-mix()). */
    const parse = (color: string): Rgba | null => {
      const srgb = color.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) };
      const rgb = color.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
      return color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const luminance = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    /* The ground behind a label: its ancestors' background colours from the first opaque one down, over black. */
    const ground = (el: HTMLElement): Rgba => {
      const layers: Rgba[] = [];
      for (let up = el.parentElement; up; up = up.parentElement) {
        const bg = parse(getComputedStyle(up).backgroundColor);
        if (!bg || bg.a <= 0) continue;
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      return layers.reverse().reduce((under, layer) => over(layer, under), { r: 0, g: 0, b: 0, a: 1 });
    };
    /* Opacity on the label and every ancestor fades it too. */
    const opacity = (el: HTMLElement) => {
      let o = 1;
      for (let up: HTMLElement | null = el; up; up = up.parentElement) o *= Number(getComputedStyle(up).opacity);
      return o;
    };
    /* #7C7C84 itself, computed the same way, is the floor. */
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const out: string[] = [];
    for (const el of labels) {
      if (!el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      /* A badge that carries its own background (the white shot number, the
         kind chip over media) owns its own contrast; the floor is about labels
         on the ground. */
      if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor)) continue;
      /* Text painted by a gradient (background-clip: text) is not its `color`. */
      if (style.backgroundClip === "text" || style.getPropertyValue("-webkit-background-clip") === "text") continue;
      const ink = parse(style.color);
      if (!ink) { out.push(`${el.className || el.tagName}: unreadable colour ${style.color}`); continue; }
      const seen = over({ ...ink, a: ink.a * opacity(el) }, ground(el));
      if (luminance(seen) < floor)
        out.push(`${el.className || el.tagName}: ${style.color}${ink.a < 1 || opacity(el) < 1 ? ` (reads ${[seen.r, seen.g, seen.b].map(Math.round).join(", ")})` : ""} — “${(el.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  }, scope);
}

/**
 * All four floors, named by where they were measured. `scroller: false` skips
 * the clearance check for a screen that has no scroller of its own yet.
 */
export async function expectFloors(page: Page, where: string, opts: { scope?: string; scroller?: boolean } = {}) {
  const { scope, scroller = true } = opts;
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, scope), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, scope), `${where}: functional labels under #7C7C84`).toEqual([]);
  if (scroller) expect(await lastRowClearsPinned(page), `${where}: clearance at max scroll`).toEqual([]);
}
