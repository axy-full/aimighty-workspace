import { currentTenant } from "./tenant";
import { productionIntended } from "./vercelGuard";

/** Shared provider credentials stay on the server. Workspace keys from the
 * previous billing mode are retained for history but never fund new work. */
export type VendorKeyName = "ark" | "gemini" | "gateway" | "openai" | "anthropic" | "fal" | "elevenlabs" | "higgsfield" | "xai";

/**
 * The vendors the money gates (credit wall, allowance, who pays) are asked about. The direct engines of the 15 Oct 2026 stack (sync.so, Sarvam, Black Forest Labs, Topaz) hold
 * no workspace key and have no key screen, so they are not VendorKeyNames: the gates read no vendor name today beyond "does the platform pay", and
 * these two name what is asking.
 */
export type EngineVendor = VendorKeyName | "sync" | "sarvam" | "bfl" | "topaz";

const ENV: Record<VendorKeyName, string> = {
  ark: "ARK_API_KEY", gemini: "GEMINI_API_KEY", gateway: "AI_GATEWAY_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  fal: "FAL_KEY", elevenlabs: "ELEVENLABS_API_KEY", higgsfield: "HF_CREDENTIALS", xai: "XAI_API_KEY",
};

export const VENDOR_KEYS: { name: VendorKeyName; label: string; does: string }[] = [
  { name: "ark", label: "Connected video account", does: "Seedance video · prompt writer" },
  { name: "gateway", label: "Connected model gateway", does: "Prompt writer · Nano Banana stills" },
  { name: "openai", label: "Connected language account", does: "Thinking models · Atomik · script development · 3D scenes, direct" },
  { name: "anthropic", label: "Anthropic · Claude", does: "Claude text models, direct (when switched on)" },
  { name: "gemini", label: "Connected image account", does: "Nano Banana stills, direct" },
  { name: "fal", label: "Connected render account", does: "Kling 3.0 video · motion control · Topaz upscale · identity training" },
  { name: "elevenlabs", label: "Connected audio account", does: "Voice · sound effects · music" },
  { name: "higgsfield", label: "Connected identity account", does: "Reusable identities · identity renders" },
  { name: "xai", label: "xAI · Grok", does: "Crew · one Grok agent per seated member" },
];

export function vendorKey(name: VendorKeyName): string | null {
  /* The Vercel AI gateway is closed in production (lib/vercelGuard.ts): a key for it is never read there, so nothing can open it. */
  if (name === "gateway" && productionIntended()) return null;
  const context = currentTenant();
  const accepted = context?.acceptedCredential;
  if (accepted?.workspaceId === context?.workspace?.id && accepted?.vendor === name)
    return accepted.value;
  if (name === "higgsfield" && !process.env.HF_CREDENTIALS && process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET)
    return `${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}`;
  return process.env[ENV[name]] || null;
}

/** The environment variable a vendor key is read from, for error messages that name it. */
export function vendorKeyEnv(name: VendorKeyName): string { return ENV[name]; }

/** The same lookup by environment-variable name, for code that speaks in those. */
export function vendorKeyForEnv(envName: string): string | null {
  const entry = (Object.entries(ENV) as [VendorKeyName, string][]).find(([, e]) => e === envName);
  return entry ? vendorKey(entry[0]) : null;
}

/**
 * The gateway may use the deployment's own identity (Vercel's OIDC token) everywhere EXCEPT production, where it is never used and
 * the gateway key is never read either (vendorKey above): the gateway is closed there (lib/vercelGuard.ts).
 */
export function deploymentIdentityAllowed(): boolean { return !productionIntended(); }
