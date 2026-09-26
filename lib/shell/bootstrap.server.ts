import { redirect } from "next/navigation";
import { currentContext, isPlatformOwner } from "@/lib/auth";
import { creditStateFor, creditsApply } from "@/lib/credits";
import { effectiveModels } from "@/lib/defaultModels";
import { getPlatformLayer, platformDb, platformReady } from "@/lib/platform";
import { buildRateTable } from "@/lib/rateTable.server";
import { runInTenant } from "@/lib/tenant";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";

/**
 * Who runs the connected Higgsfield account in this workspace, by name, for a
 * member's owner-run surfaces (lib/shell/connected-capability.ts): this
 * workspace's owner only, and only the display name — never the address.
 */
async function ownerNameOf(workspaceId: string): Promise<string | null> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.role = 'owner' AND m.disabled = 0 AND a.deleted_at IS NULL
          ORDER BY m.created_at LIMIT 1`,
    args: [workspaceId],
  });
  const name = String((rs.rows[0] as { name?: unknown } | undefined)?.name ?? "").trim();
  return name ? name.slice(0, 80) : null;
}

/**
 * What a signed-in shell needs before it renders: the request scope, the
 * account summary and the same session the (app) layout gives its pages.
 * /workspace and /suites both start here, so the two surfaces cannot drift in
 * what they know about the workspace, its credits or its rates.
 */
export async function shellBootstrap(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const ctx = await currentContext();
  if (ctx?.mfaRequired) redirect("/account/security");
  if (!ctx?.workspace) {
    const project = (await searchParams).project;
    redirect("/workbench" + (typeof project === "string" ? "?" + new URLSearchParams({ project }) : ""));
  }
  const credits = await creditStateFor(ctx.workspace).catch(() => null);
  const initialAccount = {
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
    credits: credits ? { balance: credits.balance } : null,
  };
  const scope = workbenchScopeFor(ctx.workspace.id, ctx.user.id);
  const owner = ctx.role === "owner";
  const session = {
    signedIn: true,
    requestScope: scope,
    name: ctx.user.name ?? null,
    email: ctx.user.email ?? null,
    workspace: {
      id: ctx.workspace.id, name: ctx.workspace.name, slug: ctx.workspace.slug, suspended: Boolean(ctx.workspace.suspendedAt), suspendedReason: ctx.workspace.suspendedReason, internalTest: Boolean(ctx.workspace.internalTest),
      /* A member's owner-run card names who runs the connected account; the owner needs no such line. */
      ownerName: owner ? null : await ownerNameOf(ctx.workspace.id).catch(() => null),
    },
    role: ctx.role ?? null,
    owner,
    superAdmin: await isPlatformOwner(ctx.user),
    workspaces: ctx.workspaces ?? [],
    credits,
    models: await runInTenant(ctx.workspace, () => effectiveModels()).catch(() => null),
    setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
    rates: buildRateTable(creditsApply(ctx.workspace) ? "cr" : "usd"),
  };
  return { scope, session, initialAccount };
}
