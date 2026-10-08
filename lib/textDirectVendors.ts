/**
 * Which providers' text calls go to the provider directly instead of through
 * the gateway: `TEXT_DIRECT=anthropic,google,xai` (any subset, comma-separated).
 * OpenAI is not listed here; its text goes direct whenever its key is set.
 */
export type TextDirectVendor = "anthropic" | "google" | "xai";
const KNOWN = new Set<string>(["anthropic", "google", "xai"]);
const warned = new Set<string>();

export function textDirectVendors(): Set<TextDirectVendor> {
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

export function isTextDirect(vendor: string): boolean {
  return textDirectVendors().has(vendor as TextDirectVendor);
}
