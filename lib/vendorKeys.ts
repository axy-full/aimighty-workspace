import { currentTenant } from "./tenant";

/**
 * Whose key pays for a render.
 *
 * A workspace's own key for a vendor always wins: sealed in its record,
 * unsealed only inside the process about to use it. Where it holds none,
 * the deployment's key steps in — for the platform's own workspace, and
 * for every workspace that runs on the platform's keys (the default at
 * sign-up, walled by lib/allowance.ts). A workspace on its own keys reaches
 * nothing it has not added: that vendor is simply unrouted for it.
 */
export type VendorKeyName = "ark" | "gemini" | "gateway" | "openai" | "fal" | "elevenlabs" | "higgsfield";

const ENV: Record<VendorKeyName, string> = {
  ark: "ARK_API_KEY", gemini: "GEMINI_API_KEY", gateway: "AI_GATEWAY_API_KEY", openai: "OPENAI_API_KEY",
  fal: "FAL_KEY", elevenlabs: "ELEVENLABS_API_KEY", higgsfield: "HF_CREDENTIALS",
};

export const VENDOR_KEYS: { name: VendorKeyName; label: string; does: string }[] = [
  { name: "ark", label: "Connected video account", does: "Seedance video · prompt writer" },
  { name: "gateway", label: "Connected model gateway", does: "Prompt writer · Nano Banana stills" },
  { name: "openai", label: "Connected language account", does: "Thinking models · Atomik · script development · Astra, direct" },
  { name: "gemini", label: "Connected image account", does: "Nano Banana stills, direct" },
  { name: "fal", label: "Connected render account", does: "Kling 3.0 video · motion control · Topaz upscale · identity training" },
  { name: "elevenlabs", label: "Connected audio account", does: "Voice · sound effects · music" },
  { name: "higgsfield", label: "Connected identity account", does: "Identity renders · enter API key ID:API key secret" },
];

export function vendorKey(name: VendorKeyName): string | null {
  const ws = currentTenant()?.workspace;
  if (ws) {
    const own = ws.keys[name];
    if (own) return own;
    if (!ws.usesPlatformKeys) return null;
  }
  if (name === "higgsfield" && !process.env.HF_CREDENTIALS && process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET)
    return `${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}`;
  return process.env[ENV[name]] || null;
}

/** The same lookup by environment-variable name, for code that speaks in those. */
export function vendorKeyForEnv(envName: string): string | null {
  const entry = (Object.entries(ENV) as [VendorKeyName, string][]).find(([, e]) => e === envName);
  return entry ? vendorKey(entry[0]) : null;
}

/**
 * May this workspace use the deployment's own identity (Vercel OIDC) at
 * the gateway? Only the platform's workspace: that identity bills the
 * deployment's credit, and the deployment belongs to one studio.
 */
export function deploymentIdentityAllowed(): boolean {
  const ws = currentTenant()?.workspace;
  return !ws || ws.usesPlatformKeys;
}
