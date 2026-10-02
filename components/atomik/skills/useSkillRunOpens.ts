"use client";
import { useEffect, useRef } from "react";
import { ATOMIK_OPEN_CHAT, type OpenChat } from "@/lib/shell/use-skills";

/**
 * A skill run files its plan in an Atomik chat (lib/atomikSkills.ts ›
 * runSkill) and says so on the window (lib/shell/use-skills.ts ›
 * openAtomikChat). The conversation that hears it shows that chat, read
 * afresh, so its first step is the checkpoint: a live quote and Continue,
 * as for any plan. One hook call in components/atomik/AtomikProvider.tsx.
 */
export function useSkillRunOpens(open: (detail: OpenChat) => void) {
  const latest = useRef(open);
  useEffect(() => { latest.current = open; });
  useEffect(() => {
    const heard = (event: Event) => {
      const detail = (event as CustomEvent<OpenChat>).detail;
      if (detail && typeof detail.chatId === "string" && detail.chatId) latest.current({ chatId: detail.chatId, projectId: detail.projectId ?? null });
    };
    window.addEventListener(ATOMIK_OPEN_CHAT, heard);
    return () => window.removeEventListener(ATOMIK_OPEN_CHAT, heard);
  }, []);
}
