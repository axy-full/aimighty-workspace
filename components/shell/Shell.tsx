"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { bindAtomikRail, setAtomikRail, toggleAtomikRail } from "@/lib/atomikRail";
import Header from "./Header";
import Dock from "./Dock";
import SuspendedBar from "./SuspendedBar";

/**
 * One shell, one ground (design/particl-v2/README.md §2–§5).
 *
 * The 56px header, the screen, and on a phone the dock. There is no light
 * theme any more and no second brand: Atomik is a rail on this same ground
 * (step 3), opened by its header button or ⌘J and closed by Esc, and its
 * state lives at app level, bound here to the signed-in user so it is
 * theirs across sessions.
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
    <div className="shell">
      <Header />
      <SuspendedBar />
      <div className="shell-body">{children}</div>
      <Dock />
    </div>
  );
}
