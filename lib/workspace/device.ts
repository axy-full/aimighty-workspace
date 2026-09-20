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

   WHEN the reading happens matters as much as latching it. Reading lazily at
   first render means reading at HYDRATION, and hydration is not a fixed point:
   on a cold dev compile it lands many seconds after the document was readable,
   by which time the keyboard has closed and the height has already moved. The
   answer is therefore recorded on `window` by an inline script while the
   document PARSES (`deviceProbeScript`), which is the same instant the
   `pending` CSS decides from the same query, and the latch reads that record
   rather than the live query. The live query is only the fallback for a
   document that never parsed one of these pages (a soft navigation), and the
   answer it gives is recorded too, so everything later agrees with it.

   Nothing here touches React: the probe and the record are supplied, so the
   latch is testable by driving the media query directly.
   ────────────────────────────────────────────────────────────────────────── */

export type Device = "phone" | "desktop";
/** Before the browser has answered — the server, and the hydration pass. */
export type DeviceAnswer = Device | "pending";

/** The one thing this needs from a MediaQueryList. */
export type MediaProbe = { matches: boolean };

/**
 * Where the document's answer is kept: a `window` key, so the inline script
 * that runs while the document parses and the latch that reads it later are
 * talking about the same document and nothing else.
 */
export const DEVICE_FLAG = "__pxwDevice";

/**
 * The record the latch prefers over the live query. Injected rather than read
 * from `window` directly so the latch stays testable.
 */
export type DeviceRecord = {
  read: () => Device | null;
  write: (device: Device) => void;
};

export function isDevice(value: unknown): value is Device {
  return value === "phone" || value === "desktop";
}

/** The real record: `window.__pxwDevice`, written by the parse-time script. */
export function windowDeviceRecord(): DeviceRecord {
  const store = () => window as unknown as Record<string, unknown>;
  return {
    read: () => {
      try {
        const value = store()[DEVICE_FLAG];
        return isDevice(value) ? value : null;
      } catch {
        return null;
      }
    },
    write: (device) => {
      try {
        store()[DEVICE_FLAG] = device;
      } catch {
        /* Nothing to do: the latch still holds its own answer for this document. */
      }
    },
  };
}

/**
 * The inline script that takes the decision while the document parses, for the
 * server-rendered HTML. `query` is a module constant (PHONE_QUERY); nothing
 * from a URL reaches this, and a unit test says so. It never overwrites an
 * answer this document already has.
 */
export function deviceProbeScript(query: string): string {
  return `window.${DEVICE_FLAG}=window.${DEVICE_FLAG}||(window.matchMedia("${query}").matches?"phone":"desktop")`;
}

export type DeviceLatch = {
  /** For `useSyncExternalStore`. A latched answer never changes, so this never fires. */
  subscribe: (update: () => void) => () => void;
  /** The latched answer, read from the probe the first time it is asked for. */
  snapshot: () => Device;
  serverSnapshot: () => "pending";
};

/**
 * A latch over one media query. The answer is taken once: from `record` when
 * the document already has one (the parse-time script), otherwise from `probe`,
 * which is then written back to `record`. Both are called lazily, so this can
 * be created at module scope where `window` does not exist yet.
 */
export function createDeviceLatch(probe: () => MediaProbe, record?: DeviceRecord): DeviceLatch {
  let latched: Device | null = null;
  return {
    /* Deliberately no listener: there is no update to deliver, and not
       subscribing is what makes the mid-session teleport impossible rather
       than merely unlikely. */
    subscribe: () => () => {},
    snapshot: () => {
      if (!latched) {
        latched = record?.read() ?? (probe().matches ? "phone" : "desktop");
        record?.write(latched);
      }
      return latched;
    },
    serverSnapshot: () => "pending" as const,
  };
}
