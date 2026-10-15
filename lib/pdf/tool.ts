import { PDF_PRICE } from "./contract";
import { DECK_KINDS } from "./deck";
import { PDF_SWITCH, pdfWorkersReady } from "./switch";

/**
 * The deck PDF tool, declared once (rule 11, the registry's shape: id, kind, inputs, provider, key, price, mock, who may call). The
 * button (screens come with Claude Design), Make, a board card, Atomik, a saved skill and an outside agent over MCP all call this
 * tool through the same route (POST /api/pdf), at the same price, through the same gate. It spends nothing, so any caller with a
 * render-scope token or a signed-in person may run it; no part of it is a person's alone.
 */
export const PDF_TOOL = Object.freeze({
  id: "make_deck_pdf",
  kind: "app-action" as const,
  callers: "render" as const,
  provider: "Chromium on our own export worker (our own templates only)",
  keys: ["REMOTION_WORKER_URLS", "REMOTION_WORKER_SECRETS"] as const,
  switch: PDF_SWITCH,
  route: "/api/pdf",
  kinds: DECK_KINDS,
  price: (): typeof PDF_PRICE => PDF_PRICE,
  priceLabel: PDF_PRICE.label,
  /** The mock: the same tool against an in-memory worker (tests/unit/remotionWorkerFake.ts); no browser, no network. */
  mock: "tests/unit/remotionWorkerFake.ts",
});

export function pdfToolAvailability(env: Readonly<Record<string, string | undefined>> = process.env): { available: boolean; reason: string | null } {
  if (env[PDF_SWITCH] !== "1") return { available: false, reason: "Deck PDFs are not switched on for this deployment." };
  const workers = pdfWorkersReady(env);
  return { available: workers.ready, reason: workers.reason };
}
