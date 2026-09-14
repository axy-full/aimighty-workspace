"use client";

import { useEffect, useRef } from "react";
import { appConfirm } from "@/components/dialog";

const LEAVE_EVENT = "particl:before-page-leave";
type LeaveRequest = {
  checks: Promise<boolean>[];
  suspend: ((approved: boolean) => void)[];
};

/** Confirm before a navigation or account mutation; a failed action restores the guard. */
export async function withPageLeaveGuard(
  action: () => void | Promise<void>,
): Promise<boolean> {
  const request: LeaveRequest = { checks: [], suspend: [] };
  window.dispatchEvent(new CustomEvent(LEAVE_EVENT, { detail: request }));
  if (!(await Promise.all(request.checks)).every(Boolean)) return false;
  request.suspend.forEach((suspend) => suspend(true));
  try {
    await action();
    return true;
  } finally {
    request.suspend.forEach((suspend) => suspend(false));
  }
}

/** Keep drafts in memory and ask before links, account changes or document unload. */
export function usePageLeaveGuard(dirty: boolean) {
  const approved = useRef(false);
  const prompt = useRef<Promise<boolean> | null>(null);
  const followingLink = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: Event) => {
      const request = (event as CustomEvent<LeaveRequest>).detail;
      if (!prompt.current) {
        prompt.current = appConfirm(
          "Discard unsaved changes?",
          "Your workspace name and production settings have not been saved. Stay here to save them, or discard them and leave.",
          { confirmLabel: "Discard and leave", danger: true },
        ).finally(() => {
          prompt.current = null;
        });
      }
      request.checks.push(prompt.current);
      request.suspend.push((allow) => {
        approved.current = allow;
      });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!approved.current) event.preventDefault();
    };
    const followLink = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        !link ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const destination = new URL(link.href, window.location.href);
      if (!/^https?:$/.test(destination.protocol)) return;
      // Tabs/anchors on this page keep the draft mounted.
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.origin === window.location.origin
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (followingLink.current) return;
      followingLink.current = true;
      void withPageLeaveGuard(() => {
        // An approved full navigation avoids replaying an intercepted React Link handler.
        window.location.assign(destination.href);
      }).finally(() => {
        followingLink.current = false;
      });
    };
    window.addEventListener(LEAVE_EVENT, guard);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener(LEAVE_EVENT, guard);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty]);
}
