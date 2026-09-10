"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { bindAtomikRail, setAtomikRail, toggleAtomikRail } from "@/lib/atomikRail";
import { AtomikProvider } from "@/components/atomik/AtomikProvider";
import AtomikRail from "@/components/atomik/AtomikRail";
import AtomikSheet from "@/components/atomik/AtomikSheet";
import Header from "./Header";
import Dock from "./Dock";
import SuspendedBar from "./SuspendedBar";

/**
 * One shell, one ground (design/particl-v2/README.md §2–§5).
 *
 * The 56px header; beneath it the screen with Atomik's rail on its right
 * when the rail is open (compact 300, expanded 420 — the screen reflows to
 * what is left); on a phone the dock. There is no light theme and no
 * second brand: Atomik is this rail, opened by its header button or ⌘J,
 * closed by Esc, its state kept per user across sessions. Atomik's own
 * state — the conversation, the plan, the checkpoint — lives here too, so
 * the header button shows it whether the rail is open or not.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  const { email } = useSession();
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
      <div className="shell">
        <Header />
        <SuspendedBar />
        <div className="shell-body">
          <div className="shell-page">{children}</div>
          <div className="max-md:hidden contents"><AtomikRail /></div>
          <div className="md:hidden contents"><AtomikSheet /></div>
        </div>
        <Dock />
      </div>
    </AtomikProvider>
  );
}
