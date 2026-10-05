"use client";
import { useSyncExternalStore } from "react";

/*
 * LOCAL STUB — stream 6 only, never committed. Stream 1 owns this file and its real helpers
 * (`useNewInterface()` on the client, `newInterfaceEnabled(...)` on the server); this stand-in
 * only lets the Make panel be built and tested behind the switch until theirs lands.
 *
 * On while this browser's localStorage holds `particl:new-interface` = "1" (the demo-s06 browser
 * specs set it); off everywhere else, and on the server.
 */
const KEY = "particl:new-interface";

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function subscribe(changed: () => void): () => void {
  window.addEventListener("storage", changed);
  return () => window.removeEventListener("storage", changed);
}

export function useNewInterface(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
