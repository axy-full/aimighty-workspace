import { redirect } from "next/navigation";
import { creditStateFor } from "@/lib/credits";
import Shell from "@/components/shell/Shell";
import ChatDock from "@/components/ChatDock";
import ContextMenu from "@/components/ContextMenu";
import DialogHost from "@/components/dialog";
import ViewportGuard from "@/components/ViewportGuard";
import { ProjectProvider } from "@/lib/projectContext";
import { SessionProvider } from "@/lib/session";
import { currentContext, userCount, isPlatformOwner } from "@/lib/auth";
import { effectiveModels } from "@/lib/defaultModels";
import { runInTenant } from "@/lib/tenant";
import { getPlatformLayer } from "@/lib/platform";

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
      workspace: ctx?.workspace ? { id: ctx.workspace.id, name: ctx.workspace.name, slug: ctx.workspace.slug, suspended: Boolean(ctx.workspace.suspendedAt), suspendedReason: ctx.workspace.suspendedReason } : null,
      role: ctx?.role ?? null,
      owner: Boolean(ctx?.role === "owner"),
      superAdmin: await isPlatformOwner(user),
      workspaces: ctx?.workspaces ?? [],
      credits: ctx?.workspace ? await creditStateFor(ctx.workspace).catch(() => null) : null,
      models: ctx?.workspace ? await runInTenant(ctx.workspace, () => effectiveModels()).catch(() => null) : null,
      setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
    }}>
    <ProjectProvider>
      {/* The pipeline redesign puts the project and the nav in one 52px
          header, so the top bar, the floating tab pill and the projects rail
          all go: once the header says both things, three more places saying
          them are noise. The chat dock stays — it is a fixed-position FAB for
          members and contributes no width. */}
      <Shell>
        {children}
        <ChatDock />
      </Shell>
      <ContextMenu />
      <DialogHost />
      <ViewportGuard />
    </ProjectProvider>
    </SessionProvider>
  );
}
