import DialogHost from "@/components/dialog";
import UploadRecovery from "@/components/UploadRecovery";
import WorkspaceApp from "@/components/workspace/WorkspaceApp";
import { SessionProvider } from "@/lib/session";
import { shellBootstrap } from "@/lib/shell/bootstrap.server";
import "../workspace.css";
import "../workspace-mobile.css";

export const dynamic = "force-dynamic";
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };
export const metadata = { title: "Particl — Workspace" };

/**
 * The redesigned workspace shell. Outside the (app) layout, like /workbench.
 * Signed-out visitors and accounts without a workspace go to /workbench,
 * which already handles both.
 */
export default async function Workspace({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { scope, session, initialAccount } = await shellBootstrap(searchParams);
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
