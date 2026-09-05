import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import TabBar from "@/components/TabBar";
import ChatDock from "@/components/ChatDock";
import Rail from "@/components/Rail";
import ContextMenu from "@/components/ContextMenu";
import DialogHost from "@/components/dialog";
import ViewportGuard from "@/components/ViewportGuard";
import { ProjectProvider } from "@/lib/projectContext";
import { SessionProvider } from "@/lib/session";
import { currentUser, userCount } from "@/lib/auth";

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
  const user = await currentUser();
  // No accounts at all yet → the first person here creates the admin.
  if (!user && (await userCount()) === 0) redirect("/setup");

  return (
    <SessionProvider value={{
      signedIn: Boolean(user),
      name: user?.name ?? null,
      email: user?.email ?? null,
    }}>
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
    </SessionProvider>
  );
}
