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
export type VendorKeyName = "ark" | "gemini" | "gateway" | "fal" | "elevenlabs";

const ENV: Record<VendorKeyName, string> = {
  ark: "ARK_API_KEY", gemini: "GEMINI_API_KEY", gateway: "AI_GATEWAY_API_KEY",
  fal: "FAL_KEY", elevenlabs: "ELEVENLABS_API_KEY",
};

export const VENDOR_KEYS: { name: VendorKeyName; label: string; does: string }[] = [
  { name: "ark", label: "BytePlus ModelArk", does: "Seedance video · Seedream prompt writer" },
  { name: "gateway", label: "Vercel AI Gateway", does: "Claude prompt writer · Nano Banana stills" },
  { name: "gemini", label: "Google Gemini", does: "Nano Banana stills, direct" },
  { name: "fal", label: "fal.ai", does: "Identity training · portrait renders" },
  { name: "elevenlabs", label: "ElevenLabs", does: "Voice · sound effects · music" },
];

export function vendorKey(name: VendorKeyName): string | null {
  const ws = currentTenant()?.workspace;
  if (ws) {
    const own = ws.keys[name];
    if (own) return own;
    if (!ws.usesPlatformKeys) return null;
  }
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
