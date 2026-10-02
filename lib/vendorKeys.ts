import { currentTenant } from "./tenant";

/** Shared provider credentials stay on the server. Workspace keys from the
 * previous billing mode are retained for history but never fund new work. */
export type VendorKeyName = "ark" | "gemini" | "gateway" | "openai" | "fal" | "elevenlabs" | "higgsfield" | "xai";

const ENV: Record<VendorKeyName, string> = {
  ark: "ARK_API_KEY", gemini: "GEMINI_API_KEY", gateway: "AI_GATEWAY_API_KEY", openai: "OPENAI_API_KEY",
  fal: "FAL_KEY", elevenlabs: "ELEVENLABS_API_KEY", higgsfield: "HF_CREDENTIALS", xai: "XAI_API_KEY",
};

export const VENDOR_KEYS: { name: VendorKeyName; label: string; does: string }[] = [
  { name: "ark", label: "Connected video account", does: "Seedance video · prompt writer" },
  { name: "gateway", label: "Connected model gateway", does: "Prompt writer · Nano Banana stills" },
  { name: "openai", label: "Connected language account", does: "Thinking models · Atomik · script development · Astra, direct" },
  { name: "gemini", label: "Connected image account", does: "Nano Banana stills, direct" },
  { name: "fal", label: "Connected render account", does: "Kling 3.0 video · motion control · Topaz upscale · identity training" },
  { name: "elevenlabs", label: "Connected audio account", does: "Voice · sound effects · music" },
  { name: "higgsfield", label: "Connected identity account", does: "Reusable identities · identity renders" },
  { name: "xai", label: "xAI · Grok", does: "Crew · one Grok agent per seated member" },
];

export function vendorKey(name: VendorKeyName): string | null {
  const context = currentTenant();
  const accepted = context?.acceptedCredential;
  if (accepted?.workspaceId === context?.workspace?.id && accepted?.vendor === name)
    return accepted.value;
  if (name === "higgsfield" && !process.env.HF_CREDENTIALS && process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET)
    return `${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}`;
  return process.env[ENV[name]] || null;
}

/** The same lookup by environment-variable name, for code that speaks in those. */
export function vendorKeyForEnv(envName: string): string | null {
  const entry = (Object.entries(ENV) as [VendorKeyName, string][]).find(([, e]) => e === envName);
  return entry ? vendorKey(entry[0]) : null;
}

/** The managed gateway can use the deployment identity for every workspace. */
export function deploymentIdentityAllowed(): boolean { return true; }
