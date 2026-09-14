/**
 * Fresh keys for a fresh workspace — the one vendor that mints them.
 *
 * Of the vendors this app pays, only Vercel AI Gateway lets a program create
 * a key: POST /v1/api-keys with a Vercel access token and the team id. fal,
 * ElevenLabs and BytePlus hand keys out in their dashboards and nowhere
 * else, so for those a new workspace runs on the platform's key with a
 * monthly allowance instead (lib/allowance.ts).
 *
 * A minted key is attributed to the team and inherits the team's API-key
 * DEFAULT budget — set once, in Vercel: `vercel ai-gateway budgets defaults
 * set api-key --limit 25 --refresh-period monthly` — so every workspace's
 * text spend is capped in Vercel's own books, not only ours.
 *
 * Needs VERCEL_TOKEN (an access token with AI Gateway rights on the team)
 * and VERCEL_TEAM_ID. Without them nothing is minted and the workspace
 * simply uses the deployment's gateway identity.
 */
const API = "https://api.vercel.com";

export function gatewayMintConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID);
}

function teamQuery(): string {
  return `teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID ?? "")}`;
}
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN ?? ""}`,
    "Content-Type": "application/json",
  };
}

/** Create a gateway key named for the workspace. The plaintext comes back once. */
export async function mintGatewayKey(
  name: string,
): Promise<{ id: string; key: string }> {
  if (!gatewayMintConfigured())
    throw new Error("VERCEL_TOKEN and VERCEL_TEAM_ID are not set.");
  const res = await fetch(`${API}/v1/api-keys?${teamQuery()}`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      purpose: "ai-gateway",
      name: name.slice(0, 80),
      metadata: { spendAttribution: "team" },
    }),
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `Vercel answered ${res.status}${j?.error?.message ? `: ${j.error.message}` : ""}`,
    );
  const key = j?.apiKeyString ?? j?.apiKey?.apiKeyString ?? null;
  const id = j?.id ?? j?.apiKey?.id ?? null;
  if (typeof key !== "string" || !key || typeof id !== "string" || !id)
    throw new Error("Vercel's answer carried no key.");
  return { id, key };
}

/** Invalidate a minted key — when its workspace goes, or its owner asks. */
export async function revokeGatewayKey(id: string): Promise<void> {
  if (!gatewayMintConfigured())
    throw new Error(
      "Gateway key revocation is not configured; cleanup must be retried.",
    );
  const res = await fetch(
    `${API}/v1/api-keys/${encodeURIComponent(id)}?${teamQuery()}`,
    {
      method: "DELETE",
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok && res.status !== 404)
    throw new Error(`Vercel answered ${res.status} revoking the key.`);
}
