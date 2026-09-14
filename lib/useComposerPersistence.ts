"use client";
import { useCallback, useSyncExternalStore } from "react";
import { loadDraft } from "./draft";
import {
  readPendingGeneration,
  type PendingGeneration,
} from "./workbench/pending-generation";

export type PendingAudio = PendingGeneration & {
  price?: number;
  unit?: "cr" | "usd";
};
const eventName = "particl-composer-storage";
const subscribe = (callback: () => void) => {
  window.addEventListener("storage", callback);
  window.addEventListener(eventName, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(eventName, callback);
  };
};
const serverSnapshot = () => "{}";
export const notifyComposerStorage = () =>
  window.dispatchEvent(new Event(eventName));

/** Hydrate private drafts after the server render, scoped to this account and workspace. */
export function useComposerPersistence(
  surface: string,
  pendingKey: string,
  signedIn: boolean,
  recoverAudio: boolean,
) {
  const snapshot = useCallback(() => {
    if (!signedIn) return "{}";
    try {
      const pending = recoverAudio
        ? (readPendingGeneration(
            localStorage,
            pendingKey,
          ) as PendingAudio | null)
        : null;
      if (pending) {
        const body = JSON.parse(pending.body);
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.text !== "string" ||
          !["speech", "sound", "music"].includes(body.task) ||
          !Number.isFinite(pending.price) ||
          !["cr", "usd"].includes(pending.unit ?? "")
        )
          throw new Error("Invalid audio recovery");
      }
      return JSON.stringify({ draft: loadDraft(surface, true), pending });
    } catch {
      return JSON.stringify({
        error:
          "The saved audio request cannot be read. Check Activity before starting another take.",
      });
    }
  }, [surface, pendingKey, signedIn, recoverAudio]);
  return JSON.parse(
    useSyncExternalStore(subscribe, snapshot, serverSnapshot),
  ) as { draft?: string; pending?: PendingAudio | null; error?: string };
}
