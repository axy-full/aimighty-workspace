import { redirect } from "next/navigation";
import { creditStateFor } from "@/lib/credits";
import Shell from "@/components/shell/Shell";
import ContextMenu from "@/components/ContextMenu";
import DialogHost from "@/components/dialog";
import ViewportGuard from "@/components/ViewportGuard";
import { ProjectProvider } from "@/lib/projectContext";
import { SessionProvider } from "@/lib/session";
import { currentContext, userCount, isPlatformOwner } from "@/lib/auth";
import { effectiveModels } from "@/lib/defaultModels";
import { runInTenant } from "@/lib/tenant";
import { getPlatformLayer } from "@/lib/platform";
import { buildRateTable } from "@/lib/rateTable.server";
import { creditsApply } from "@/lib/credits";

/**
 * The shell, for everyone.
 *
 * This layout used to turn anyone without a session away at the door. It no
 * longer does: the interface is public and the work inside it is not. A
 * visitor gets every screen, every control and every empty panel, and not
 * one render, project or figure — because each of those comes from a route
 * that answers 401 to an anonymous caller, and spending routes answer 401
 * before they reach a vendor.
 *
 * That is worth being precise about: opening this door is safe ONLY because
 * the API was already closed. Nothing below is a guard. If a future route
 * forgets requireUser, this layout will not catch it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await currentContext();
  const user = ctx?.user ?? null;
  // No accounts at all yet → the first person here becomes the platform's owner.
  if (!user && (await userCount()) === 0) redirect("/setup");

  return (
    <SessionProvider value={{
      signedIn: Boolean(user),
      name: user?.name ?? null,
      email: user?.email ?? null,
      workspace: ctx?.workspace ? { id: ctx.workspace.id, name: ctx.workspace.name, slug: ctx.workspace.slug, suspended: Boolean(ctx.workspace.suspendedAt), suspendedReason: ctx.workspace.suspendedReason, internalTest: Boolean(ctx.workspace.internalTest) } : null,
      role: ctx?.role ?? null,
      owner: Boolean(ctx?.role === "owner"),
      superAdmin: await isPlatformOwner(user),
      workspaces: ctx?.workspaces ?? [],
      credits: ctx?.workspace ? await creditStateFor(ctx.workspace).catch(() => null) : null,
      models: ctx?.workspace ? await runInTenant(ctx.workspace, () => effectiveModels()).catch(() => null) : null,
      setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
      /* The rates this browser may see, in the unit this workspace pays in.
         Built here rather than fetched, so a VISITOR gets one too: signed out
         there is no workspace and no /api/me, and without a table the composer
         fell back to dollars — which is how the platform's vendor cost came to
         be printed on a public page. A visitor is quoted credits at the
         platform's own margin, like the customer they might become.
         The internal flag is passed by hand: this call runs outside any
         tenant scope (only effectiveModels above is wrapped in runInTenant),
         so buildRateTable's own currentTenant() read would be null here and
         an internal studio's composer would quote the 1.5x table its ledger
         never bills. */
      rates: buildRateTable(!ctx?.workspace || creditsApply(ctx.workspace) ? "cr" : "usd", Boolean(ctx?.workspace?.internal)),
    }}>
    <ProjectProvider>
      {/* The v2 shell (design/particl-v2 §3–§5): one 56px header with the
          four items, the balance, the Atomik button and the account menu;
          the dock on a phone. Nothing else floats over a screen — the team
          chat FAB and the ⌘K palette are not in the handoff and are gone
          with the old shell. */}
      <Shell>{children}</Shell>
      <ContextMenu />
      <DialogHost />
      <ViewportGuard />
    </ProjectProvider>
    </SessionProvider>
  );
}
