import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import TabBar from "@/components/TabBar";
import ChatDock from "@/components/ChatDock";
import Rail from "@/components/Rail";
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
        <TopBar />
        <div className="app-work">
          {/* A third child of a row that already had room: the chat dock's
              own children are all fixed, so it contributes no width. */}
          <Rail />
          <div className="min-h-0 min-w-0 flex-1">{children}</div>
          <ChatDock />
        </div>
        <TabBar />
        <ContextMenu />
        <DialogHost />
        <ViewportGuard />
      </div>
    </ProjectProvider>
  );
}
