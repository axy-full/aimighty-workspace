import { redirect } from "next/navigation";
import { currentContext, isPlatformOwner } from "@/lib/auth";
import { creditStateFor, creditsApply } from "@/lib/credits";
import { effectiveModels } from "@/lib/defaultModels";
import { getPlatformLayer } from "@/lib/platform";
import { buildRateTable } from "@/lib/rateTable.server";
import { runInTenant } from "@/lib/tenant";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";

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
  const session = {
    signedIn: true,
    requestScope: scope,
    name: ctx.user.name ?? null,
    email: ctx.user.email ?? null,
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name, slug: ctx.workspace.slug, suspended: Boolean(ctx.workspace.suspendedAt), suspendedReason: ctx.workspace.suspendedReason, internalTest: Boolean(ctx.workspace.internalTest) },
    role: ctx.role ?? null,
    owner: ctx.role === "owner",
    superAdmin: await isPlatformOwner(ctx.user),
    workspaces: ctx.workspaces ?? [],
    credits,
    models: await runInTenant(ctx.workspace, () => effectiveModels()).catch(() => null),
    setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
    rates: buildRateTable(creditsApply(ctx.workspace) ? "cr" : "usd"),
  };
  return { scope, session, initialAccount };
}
