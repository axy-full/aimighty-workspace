import type { Page } from "@playwright/test";

/** Every visible text node inside `scope` under 12 px (the floor), with its size: Atomik's own surfaces only. */
export async function smallTextIn(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const out: string[] = [];
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(scope))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? "").trim();
        const el = node.parentElement;
        if (!text || !el || !el.getClientRects().length) continue;
        const size = Number.parseFloat(getComputedStyle(el).fontSize);
        if (size < 12) out.push(`${size}px: “${text.slice(0, 40)}” (${el.className || el.tagName})`);
      }
    }
    return out;
  }, scope);
}
