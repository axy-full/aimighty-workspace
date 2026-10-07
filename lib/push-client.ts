"use client";
import { useCallback, useEffect, useState } from "react";
import { useScopedFetch } from "./useScopedFetch";

/**
 * Push on this device, from the browser's side (lib/push.ts is the server's).
 *
 * One way to ask: register the notifications-only service worker (public/sw.js), ask the browser's
 * permission, subscribe with the deployment's public VAPID key, and hand the subscription to
 * POST /api/push/subscribe. Turning it off is POST /api/push/unsubscribe, then the browser's own
 * unsubscribe. Workspace Settings' switch and the phone's "Notify me" both use this, so the two never
 * disagree about whether this device is told.
 *
 * What a person is told is lib/notifyPrefs.ts's (a take they asked for finished, and the rest), sent
 * by the server through lib/push.ts. Nothing here sends anything.
 */

/** `install`: an iPhone or iPad in Safari, where push needs the site added to the Home Screen first. */
export type PushState = "off" | "on" | "busy" | "denied" | "install" | "unconfigured" | "unsupported";

export const PUSH_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export function urlB64ToUint8Array(value: string) {
  const b64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from([...atob(b64)].map((c) => c.charCodeAt(0)));
}

/** Why this device can't be told, in the settings page's words, or null when it can. */
export function pushUnavailable(state: PushState): string | null {
  return state === "denied"
    ? "blocked in the browser"
    : state === "install"
      ? "add to the Home Screen first"
      : state === "unconfigured"
        ? "not set up here"
        : state === "unsupported"
          ? "not supported in this browser"
          : null;
}

/** What the browser can do, read without asking anything of the person. */
async function readState(): Promise<PushState> {
  if (!("serviceWorker" in navigator && "PushManager" in window)) {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;
    return ios ? "install" : "unsupported";
  }
  if (!PUSH_KEY) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  return reg && (await reg.pushManager.getSubscription()) ? "on" : "off";
}

/** `refused`: the person said no to the browser's own question; that is an answer, not a fault. */
export type PushOutcome = { ok: true } | { ok: false; error: string; refused?: true };

export function usePushSubscription() {
  const scopedFetch = useScopedFetch();
  const [state, setState] = useState<PushState>("off");
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(readState).then((next) => { if (alive) setState(next); }, () => {});
    return () => { alive = false; };
  }, []);

  /** Asks the browser's permission (the person's own tap), then files the subscription. */
  const enable = useCallback(async (): Promise<PushOutcome> => {
    setState("busy");
    try {
      if (!PUSH_KEY) throw new Error("The push keys aren't in this build yet.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return { ok: false, refused: true, error: perm === "denied" ? "Notifications are blocked in the browser." : "Notifications were not allowed." };
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(PUSH_KEY) });
      const res = await scopedFetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The server rejected it.");
      setState("on");
      return { ok: true };
    } catch (e) {
      setState(PUSH_KEY ? "off" : "unconfigured");
      return { ok: false, error: (e as Error).message };
    }
  }, [scopedFetch]);

  const disable = useCallback(async (): Promise<PushOutcome> => {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        const response = await scopedFetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Notification settings could not be changed.");
        await sub.unsubscribe();
      }
      setState("off");
      return { ok: true };
    } catch (e) {
      setState("on");
      return { ok: false, error: (e as Error).message };
    }
  }, [scopedFetch]);

  return { state, enable, disable };
}
