import { redirect } from "next/navigation";
import DialogHost from "@/components/dialog";
import UploadRecovery from "@/components/UploadRecovery";
import WorkspaceApp from "@/components/workspace/WorkspaceApp";
import { currentContext, isPlatformOwner } from "@/lib/auth";
import { creditStateFor, creditsApply } from "@/lib/credits";
import { effectiveModels } from "@/lib/defaultModels";
import { getPlatformLayer } from "@/lib/platform";
import { buildRateTable } from "@/lib/rateTable.server";
import { SessionProvider } from "@/lib/session";
import { runInTenant } from "@/lib/tenant";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import "../workspace.css";

export const dynamic = "force-dynamic";
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };
export const metadata = { title: "Particl — Workspace" };

/**
 * The redesigned workspace shell. Outside the (app) layout, like /workbench.
 * Signed-out visitors and accounts without a workspace go to /workbench,
 * which already handles both.
 */
export default async function Workspace({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  /* The same session the (app) layout gives its pages, so the existing suite
     tools the spec pages mount (Atomik, Subatomik, Deliver) read the same
     scope, rates and models here. */
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
  return (
    <SessionProvider key={scope} value={session}>
      <WorkspaceApp key={scope} scope={scope} initialAccount={initialAccount} />
      {/* Two of the hosts the (app) layout gives its pages. The workspace
          mounts the same old panels (Atomik, Subatomik, the Studio tools) and
          those call appAlert/appConfirm; without DialogHost those calls were
          silently dead here. Now that this is the default surface, an
          interrupted upload has to be recoverable from it too.
          ContextMenu is deliberately NOT mounted: it needs ProjectProvider
          and its 30s /api/projects poll, and no workspace page opens it. */}
      <DialogHost />
      <UploadRecovery scope={scope} />
    </SessionProvider>
  );
}
