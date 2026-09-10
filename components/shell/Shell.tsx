"use client";

import { usePathname } from "next/navigation";
import { onPaper } from "@/lib/ground";
import AppHeader from "./AppHeader";
import AtomikHeader from "./AtomikHeader";
import TabBar, { MakeTabs } from "./TabBar";
import SuspendedBar from "./SuspendedBar";

/**
 * One shell, two grounds.
 *
 * Every screen sits under a 52px header and fills the rest of the viewport.
 * Which header, and which ground, is decided here by the route — and they are
 * two questions, not one. The header is a brand question: atomik's stages get
 * atomik's header. The ground is `onPaper`, which is a slightly longer list,
 * because a statement is particl's own screen and still paper.
 *
 * The subtree is wrapped in `.theme-light`, which re-tokens every var()
 * beneath it — so the same components, the same classes and the same session
 * render both halves, and only the values change. Putting it on the shell
 * rather than on the page is what makes a route paper in every state it has:
 * signed out, loading, in error, and rendered.
 *
 * This is the one place that knows there are two brands. A page never asks
 * which ground it is on.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const atomik = path.startsWith("/atomik");
  return (
    <div className={`shell ${onPaper(path) ? "theme-light" : ""}`}>
      {atomik ? <AtomikHeader /> : <AppHeader />}
      <SuspendedBar />
      {!atomik && <MakeTabs />}
      <div className="shell-body">{children}</div>
      <TabBar />
    </div>
  );
}
