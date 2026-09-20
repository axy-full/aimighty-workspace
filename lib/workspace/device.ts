/* ──────────────────────────────────────────────────────────────────────────
   The device decision, latched to one document.

   The switch-over gate asks one question — is this a phone? — and acts on the
   answer by replacing the URL. That makes the question unlike an ordinary
   media query: re-answering it later does not re-style a page, it teleports
   somebody out of the surface they are using.

   And the phone half of PHONE_QUERY is not stable within a document. A touch
   phone held landscape matches on `max-height: 500px`, and that height moves
   on its own while nobody rotates anything: a keyboard closing, browser
   chrome collapsing, `interactive-widget=resizes-content`, a dev overlay. Each
   of those made the old gate re-decide, and a phone that crossed 500px was
   redirected into the desktop workspace mid-session.

   So the answer is read once per document and never again. A genuine rotation
   still decides freshly, because it is a new document (the gate runs on a page
   load, and a rotation that reloads re-runs it); only a live media-query
   change inside one document is ignored.

   Nothing here touches React or the DOM: the probe is supplied, so the latch
   is testable by driving the media query directly.
   ────────────────────────────────────────────────────────────────────────── */

export type Device = "phone" | "desktop";
/** Before the browser has answered — the server, and the hydration pass. */
export type DeviceAnswer = Device | "pending";

/** The one thing this needs from a MediaQueryList. */
export type MediaProbe = { matches: boolean };

export type DeviceLatch = {
  /** For `useSyncExternalStore`. A latched answer never changes, so this never fires. */
  subscribe: (update: () => void) => () => void;
  /** The latched answer, read from the probe the first time it is asked for. */
  snapshot: () => Device;
  serverSnapshot: () => "pending";
};

/**
 * A latch over one media query. `probe` is called at most once, the first time
 * the answer is wanted — lazily, so this can be created at module scope where
 * `window` does not exist yet.
 */
export function createDeviceLatch(probe: () => MediaProbe): DeviceLatch {
  let latched: Device | null = null;
  return {
    /* Deliberately no listener: there is no update to deliver, and not
       subscribing is what makes the mid-session teleport impossible rather
       than merely unlikely. */
    subscribe: () => () => {},
    snapshot: () => {
      if (!latched) latched = probe().matches ? "phone" : "desktop";
      return latched;
    },
    serverSnapshot: () => "pending" as const,
  };
}
