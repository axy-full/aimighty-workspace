/**
 * The connected account's developer API — the REST gateway the Higgsfield
 * CLI talks to (`fnf-api-gw.higgsfield.ai/fnf`, `/developer/v1alpha/marketing-studio/*`
 * for products · avatars · hooks · ad references · brand kits, `/developer/v2alpha/*`
 * for jobs and media), behind the same Clerk OAuth as the MCP. The account's
 * MCP toolset does not offer setup-item creation or the DTC Ads Engine; the
 * gateway does. Whether the grant this app holds (resource = the MCP) is
 * accepted there is not known until asked, so the first thing this module
 * does is ASK, with a free read, and report the answer plainly.
 *
 * Nothing here spends, retries, or logs a token.
 */
export const DEVELOPER_API_BASE = "https://fnf-api-gw.higgsfield.ai/fnf";
export const DEVELOPER_PROBE_PATH = "/developer/v2alpha/account/balance";
const PROBE_TIMEOUT_MS = 10_000;
const BODY_LIMIT = 16_000;

export type DeveloperProbe =
  | { reachable: true; balance: number | null; unit: string | null }
  | { reachable: false; status: number | null; reason: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** What a probe reply means; provider text is never surfaced. */
export function parseDeveloperProbe(status: number, body: unknown): DeveloperProbe {
  if (status === 200) {
    const source = record(body) ? (record(body.balance) ? body.balance : body) : {};
    const balance = ["credits", "balance", "amount", "available"].map((key) => source[key]).find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined;
    const unit = typeof source.unit === "string" ? source.unit.slice(0, 32) : typeof source.currency === "string" ? source.currency.slice(0, 32) : null;
    return { reachable: true, balance: balance ?? null, unit };
  }
  if (status === 401 || status === 403)
    return { reachable: false, status, reason: "The developer API refused this account's grant: the connection is scoped to the MCP, and the gateway wants a token of its own. Setup items and DTC ads stay on the CLI until the account can issue one." };
  if (status === 404) return { reachable: false, status, reason: "The developer API answered, but not at the path the CLI uses (404). The gateway may have moved." };
  if (status === 429) return { reachable: false, status, reason: "The developer API is rate-limiting this account. Try again in a minute." };
  return { reachable: false, status, reason: `The developer API could not be read (HTTP ${status}).` };
}

/** One free read with the account's token; a network failure is a plain answer, never a throw. */
export async function probeDeveloperApi(accessToken: string, fetcher: typeof fetch = fetch): Promise<DeveloperProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(`${DEVELOPER_API_BASE}${DEVELOPER_PROBE_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: controller.signal,
      redirect: "manual",
    });
    const text = (await response.text().catch(() => "")).slice(0, BODY_LIMIT);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return parseDeveloperProbe(response.status, body);
  } catch (error) {
    return { reachable: false, status: null, reason: error instanceof Error && error.name === "AbortError" ? "The developer API did not answer within 10 seconds." : "The developer API could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}
