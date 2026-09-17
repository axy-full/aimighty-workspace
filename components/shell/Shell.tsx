"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { bindAtomikRail, setAtomikRail, toggleAtomikRail } from "@/lib/atomikRail";
import { AtomikProvider } from "@/components/atomik/AtomikProvider";
import AtomikRail from "@/components/atomik/AtomikRail";
import AtomikSheet from "@/components/atomik/AtomikSheet";
import Header from "./Header";
import { useMobileViewport } from "@/components/workbench/mobile-ui";
import Dock from "./Dock";
import SuspendedBar from "./SuspendedBar";

/** Shared Studio / Gen / Workspace navigation. Gen and management own their
 * entire content area; older production tools retain their contextual rail. */
export default function Shell({ children }: { children: React.ReactNode }) {
  useMobileViewport();
  const { email } = useSession();
  const path = usePathname();
  const focusedSection = /^\/(pipelines|settings|team|usage|statements)(\/|$)/.test(path);
  useEffect(() => { bindAtomikRail(email ?? "visitor"); }, [email]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); toggleAtomikRail(); }
      else if (e.key === "Escape") setAtomikRail("closed");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <AtomikProvider>
      <div className="shell studio-application">
        <Header />
        <SuspendedBar />
        <div className="shell-body">
          <div className="shell-page">{children}</div>
          {!focusedSection && <><div className="max-md:hidden contents"><AtomikRail /></div>
          <div className="md:hidden contents"><AtomikSheet /></div></>}
        </div>
        <Dock />
      </div>
    </AtomikProvider>
  );
}
