import { redirect } from "next/navigation";
import TitleBar from "@/components/TitleBar";
import PageSwitcher from "@/components/PageSwitcher";
import NavRail from "@/components/NavRail";
import ChatDock from "@/components/ChatDock";
import ContextMenu from "@/components/ContextMenu";
import DialogHost from "@/components/dialog";
import ViewportGuard from "@/components/ViewportGuard";
import { ProjectProvider } from "@/lib/projectContext";
import { currentUser, userCount } from "@/lib/auth";

/** Everything under this layout requires a signed-in user. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) {
    // No accounts at all yet → send the first person to create the admin.
    redirect((await userCount()) === 0 ? "/setup" : "/login");
  }

  return (
    <ProjectProvider>
      <div className="app">
        <NavRail user={user} />
        <div className="app-main">
          <TitleBar user={user} />
          <div className="app-work">
            <div className="min-h-0 min-w-0 flex-1">{children}</div>
            <ChatDock />
          </div>
          <PageSwitcher />
        </div>
        <ContextMenu />
        <DialogHost />
        <ViewportGuard />
      </div>
    </ProjectProvider>
  );
}
