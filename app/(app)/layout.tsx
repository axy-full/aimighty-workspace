import { redirect } from "next/navigation";
import TitleBar from "@/components/TitleBar";
import PageSwitcher from "@/components/PageSwitcher";
import ChatDock from "@/components/ChatDock";
import ProjectDrawer from "@/components/ProjectDrawer";
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
        <TitleBar user={user} />
        <div className="app-work flex">
          <ProjectDrawer />
          <div className="min-h-0 min-w-0 flex-1">{children}</div>
          <ChatDock />
        </div>
        <PageSwitcher isAdmin={user.role === "admin"} />
      </div>
    </ProjectProvider>
  );
}
