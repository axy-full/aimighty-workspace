import { redirect } from "next/navigation";
import TitleBar from "@/components/TitleBar";
import PageSwitcher from "@/components/PageSwitcher";
import { currentUser, userCount } from "@/lib/auth";

/** Everything under this layout requires a signed-in user. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) {
    // No accounts at all yet → send the first person to create the admin.
    redirect((await userCount()) === 0 ? "/setup" : "/login");
  }

  return (
    <div className="app">
      <TitleBar user={user} />
      <div className="app-work">{children}</div>
      <PageSwitcher isAdmin={user.role === "admin"} />
    </div>
  );
}
