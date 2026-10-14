/**
 * Which providers' text calls go to the provider directly instead of through
 * the gateway: `TEXT_DIRECT=anthropic,google,xai` (any subset, comma-separated).
 * OpenAI is not listed here; its text goes direct whenever its key is set.
 * Google is the same: Gemini text always goes straight to Google's own API with the
 * shared safety settings (lib/geminiSafety.ts), never through the gateway (Vercel out,
 * owner 14 Oct 2026), so it is in the set whatever `TEXT_DIRECT` says. A Gemini id with
 * no direct model, or no Gemini key, is refused; it never falls back to the gateway.
 */
export type TextDirectVendor = "anthropic" | "google" | "xai";
const KNOWN = new Set<string>(["anthropic", "google", "xai"]);
const warned = new Set<string>();
const ALWAYS_DIRECT: readonly TextDirectVendor[] = ["google"];

/** The vendors `TEXT_DIRECT` itself lists (not the always-direct ones): what switches a default on, as before. */
export function listedTextDirectVendors(): Set<TextDirectVendor> {
  const out = new Set<TextDirectVendor>();
  for (const part of (process.env.TEXT_DIRECT ?? "").split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (KNOWN.has(name)) out.add(name as TextDirectVendor);
    else if (!warned.has(name)) {
      warned.add(name);
      console.warn(`TEXT_DIRECT: ignoring unknown vendor "${name}" (expected anthropic, google or xai)`);
    }
  }
  return out;
}

/** Every vendor whose text goes direct: the listed ones and the always-direct ones. */
export function textDirectVendors(): Set<TextDirectVendor> {
  return new Set<TextDirectVendor>([...ALWAYS_DIRECT, ...listedTextDirectVendors()]);
}

export function isTextDirect(vendor: string): boolean {
  return textDirectVendors().has(vendor as TextDirectVendor);
}
