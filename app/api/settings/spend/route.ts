import { requireAdmin, requireSession, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { parseSpendPatch } from "@/lib/spendSettings";
import { SpendSettingsError, changeSpendSettings, readSpendSettings, spendSettingsOn } from "@/lib/spendSettings.server";
import { PeopleOnlyError } from "@/lib/security/people-only";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/* With the switch off this route answers as if it did not exist, before anything else is read. */
const notFound = () => Response.json({ error: "Not found." }, { status: 404, headers });

function refused(error: unknown): Response {
  if (error instanceof SpendSettingsError || error instanceof PeopleOnlyError) return Response.json({ error: error.message }, { status: error.status, headers });
  throw error;
}

/**
 * A workspace's own spend settings (lib/spendSettings.ts; v30 A4, behind V30_SPEND_LIMIT, off): the monthly spend
 * limit in credits, the paused state, and ask before every take. Stored only: nothing that spends reads them yet.
 *
 * Read: any signed-in member of the workspace. Change: an admin who is a person; an API or MCP token, of any scope,
 * is refused on both (requireSession), and the store refuses an `agent:` identity too. The workspace is the
 * session's: no workspace id is taken from the request.
 */
export const GET = withTenant(async () => {
  if (!(await spendSettingsOn(currentTenant()?.workspace))) return notFound();
  const got = await requireSession();
  if (got.response) return got.response;
  try {
    return Response.json({ settings: await readSpendSettings() }, { headers });
  } catch (error) { return refused(error); }
});

export const PATCH = withTenant(async (req: Request) => {
  if (!(await spendSettingsOn(currentTenant()?.workspace))) return notFound();
  const got = await requireAdmin();
  if (got.response) return got.response;
  const parsed = parseSpendPatch(await req.json().catch(() => null));
  if (parsed.error !== undefined) return Response.json({ error: parsed.error }, { status: 400, headers });
  try {
    return Response.json(await changeSpendSettings(parsed.patch), { headers });
  } catch (error) { return refused(error); }
}, { requireRequestScope: true });
