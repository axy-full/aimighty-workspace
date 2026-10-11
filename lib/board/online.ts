"use client";
import { useSyncExternalStore } from "react";

/** Whether the browser says it is online (README § 3.1 "offline": the board is read-only while it is not). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener("online", notify);
      window.addEventListener("offline", notify);
      return () => { window.removeEventListener("online", notify); window.removeEventListener("offline", notify); };
    },
    () => navigator.onLine,
    () => true,
  );
}
