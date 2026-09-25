"use client";

import { useEffect, useRef, useState } from "react";
import { posterSrc } from "@/lib/format";
import { assetIdFromUrl, previewAttrs } from "@/lib/preview";
import { dragAttrs } from "@/lib/drop";

/**
 * A render on a wall, done the way galleries do it.
 *
 * Two problems, one answer. Grids used to mount a <video> per card, so a
 * page of thumbnails fired hundreds of media requests; and a browser will
 * quietly refuse to PAINT more than a handful of paused videos at once —
 * every frame decoded, most tiles grey. So each render is turned into one
 * poster image, captured once through a short queue, and shown as an <img>.
 * A real <video> is mounted only while the pointer rests on it, and only one
 * plays at a time. If a capture cannot happen (a frame that never seeks, a
 * canvas the browser will not read), the tile falls back to the plain
 * video element it always had.
 *
 * Media still mounts only once its card is near the viewport, and stays
 * mounted afterwards so scrolling back is instant.
 */

const posters = new Map<string, string | "fail">();
const POSTERS_MAX = 150;
/** Keep the map small: the oldest entry goes when the cap is reached. */
function remember(url: string, frame: string) {
  if (posters.size >= POSTERS_MAX) {
    const oldest = posters.keys().next().value;
    if (oldest !== undefined) posters.delete(oldest);
  }
  posters.set(url, frame);
}
const inflight = new Map<string, Promise<string | "fail">>();
const MAX_CAPTURES = 2;
let capturing = 0;
const waiting: (() => void)[] = [];
function take(): Promise<void> {
  return new Promise((res) => {
    const go = () => { capturing++; res(); };
    if (capturing < MAX_CAPTURES) go(); else waiting.push(go);
  });
}
function give() { capturing--; waiting.shift()?.(); }

/* Posters outlive a reload: a budgeted store in localStorage, keyed by the
   render, with an index that remembers insertion order. The budget is in
   characters — a 9:16 poster is several times a 16:9 one, so counting
   entries said nothing about the quota — and a quota error evicts the whole
   store and retries once, so a full poster cache can never take the app's
   own preferences down with it. */
const STORE_PREFIX = "aw_poster:";
const STORE_INDEX = "aw_posters:index";
const STORE_BUDGET = 1_500_000; // characters, well under every browser's ~5M
function readIndex(): string[] {
  try { return JSON.parse(localStorage.getItem(STORE_INDEX) ?? "[]") as string[]; } catch { return []; }
}
function readStored(url: string): string | null {
  try { return localStorage.getItem(STORE_PREFIX + url); } catch { return null; }
}
function isQuota(e: unknown): boolean {
  const err = e as { name?: string; code?: number };
  return err?.name === "QuotaExceededError" || err?.name === "NS_ERROR_DOM_QUOTA_REACHED" || err?.code === 22 || err?.code === 1014;
}
function writeStored(url: string, dataUrl: string) {
  try {
    let index = readIndex().filter((u) => u !== url);
    let total = index.reduce((a, u) => a + (localStorage.getItem(STORE_PREFIX + u)?.length ?? 0), 0);
    while (index.length && total + dataUrl.length > STORE_BUDGET) {
      const oldest = index.shift()!;
      total -= localStorage.getItem(STORE_PREFIX + oldest)?.length ?? 0;
      localStorage.removeItem(STORE_PREFIX + oldest);
    }
    try {
      localStorage.setItem(STORE_PREFIX + url, dataUrl);
    } catch (e) {
      if (!isQuota(e)) throw e;
      // Somebody else's data is taking the room. Start the store over.
      for (const u of index) localStorage.removeItem(STORE_PREFIX + u);
      index = [];
      localStorage.setItem(STORE_PREFIX + url, dataUrl);
    }
    index.push(url);
    localStorage.setItem(STORE_INDEX, JSON.stringify(index));
  } catch { /* quota still, or private mode — captured again next time */ }
}

/** A hidden, in-document parking spot: some browsers deprioritise or never
 *  load a video that isn't attached anywhere. */
function parking(): HTMLElement {
  let el = document.getElementById("aw-poster-parking");
  if (!el) {
    el = document.createElement("div");
    el.id = "aw-poster-parking";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;left:-9999px;top:0;width:4px;height:4px;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(el);
  }
  return el;
}

function capturePoster(url: string): Promise<string | "fail"> {
  const cached = posters.get(url);
  if (cached) return Promise.resolve(cached);
  const stored = readStored(url);
  if (stored) { remember(url, stored); return Promise.resolve(stored); }
  const running = inflight.get(url);
  if (running) return running;

  const job = (async (): Promise<string | "fail"> => {
    await take();
    const v = document.createElement("video");
    try {
      // Same-origin bytes for this one request, so the canvas may read them.
      const src = `${url}${url.includes("?") ? "&" : "?"}stream=1`;
      const frame = await new Promise<string>((resolve, reject) => {
        v.muted = true; v.playsInline = true; v.preload = "metadata";
        v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
        const timer = setTimeout(() => reject(new Error("poster timeout")), 7_000);
        v.addEventListener("error", () => { clearTimeout(timer); reject(new Error("video error")); }, { once: true });
        v.addEventListener("loadedmetadata", () => {
          try { v.currentTime = Math.min(0.1, Math.max(0, v.duration - 0.05)); }
          catch { /* the seeked handler simply never fires; the timer rejects */ }
        }, { once: true });
        v.addEventListener("seeked", () => {
          // Draw NOW, in the event itself. `seeked` means the frame at the new
          // time is decoded (readyState is already HAVE_ENOUGH_DATA here).
          // Waiting an animation frame felt safer and was a trap: a background
          // tab never gets one, so every capture timed out and the whole wall
          // was marked failed for the session.
          clearTimeout(timer);
          try {
            // A thumbnail, not a still: 480 wide is sharper than any tile on
            // the wall and a third the bytes of the 640 it started at.
            const vw = v.videoWidth || 480, vh = v.videoHeight || 270;
            const w = Math.min(vw, 480), h = Math.round((w * vh) / vw);
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d")!.drawImage(v, 0, 0, w, h);
            resolve(c.toDataURL("image/jpeg", 0.8));
          } catch (e) { reject(e as Error); }
        }, { once: true });
        parking().appendChild(v);
        v.src = src;
        v.load();
      });
      remember(url, frame);
      writeStored(url, frame);
      return frame;
    } catch {
      // Not remembered: a capture that failed under load or in a background
      // tab deserves another go the next time the render is mounted.
      return "fail";
    } finally {
      // Release the decoder and the connection whatever happened.
      try { v.removeAttribute("src"); v.load(); v.remove(); } catch { /* already gone */ }
      inflight.delete(url);
      give();
    }
  })();
  inflight.set(url, job);
  return job;
}

export default function LazyMedia({
  url, kind, alt, className = "", placeholder, hoverPlay = false, name, preview = true,
}: {
  url: string;
  kind: "video" | "image";
  alt?: string;
  className?: string;
  placeholder?: React.ReactNode;
  /** Play (muted, looping) while the pointer rests on it; the poster otherwise. */
  hoverPlay?: boolean;
  /** The asset's name in the previewer (defaults to `alt`). */
  name?: string;
  /** Every render shown is previewable (components/PreviewLayer); false only where the tile is itself a player. */
  preview?: boolean;
}) {
  const holder = useRef<HTMLSpanElement>(null);
  // Browsers without IntersectionObserver just show everything, as before.
  // A render whose poster is already known shows at once too — a remounted
  // tile (the wall re-deals its columns when a render lands) must not blink.
  const [show, setShow] = useState(
    () => typeof window !== "undefined" &&
      (typeof IntersectionObserver === "undefined" || (kind === "video" && posters.has(url)))
  );
  // Keyed by url: a tile that first mounted on the vendor's temporary URL and
  // later receives the stored one must capture again, not keep a stale answer.
  const [posterState, setPoster] = useState<{ url: string; value: string | "fail" | null }>(
    () => ({ url, value: posters.get(url) ?? null })
  );
  const poster = posterState.url === url ? posterState.value : (posters.get(url) ?? null);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (show) return;
    const el = holder.current;
    if (!el) return;

    const MARGIN = 400; // a screen's runway, so media is ready before it's reached

    /** Belt to the observer's braces. Browsers don't deliver intersection
     *  callbacks to a hidden page, and throttle them under load — without a
     *  measured fallback a card could sit as a grey placeholder forever, which
     *  looks exactly like a broken library. */
    const measure = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 0;
      if (r.bottom > -MARGIN && r.top < vh + MARGIN) { setShow(true); return true; }
      return false;
    };

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) { setShow(true); io?.disconnect(); }
        },
        { rootMargin: `${MARGIN}px` }
      );
      io.observe(el);
    }

    const t = setTimeout(measure, 250);
    const onVisible = () => { if (!document.hidden) measure(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
      io?.disconnect();
    };
  }, [show]);

  // Once in view, a video gets its poster; the result is shared by every
  // card that shows the same render, on this screen and the next.
  useEffect(() => {
    if (!show || kind !== "video" || poster) return;
    let alive = true;
    capturePoster(url).then((p) => { if (alive) setPoster({ url, value: p }); });
    return () => { alive = false; };
  }, [show, kind, url, poster]);

  const canHover = hoverPlay && typeof matchMedia !== "undefined" && matchMedia("(hover: hover)").matches;

  return (
    <span
      ref={holder}
      className={`relative block h-full w-full ${className}`}
      {...(preview && url ? { ...previewAttrs({ url, kind, name: name ?? alt }), ...dragAttrs(assetIdFromUrl(url), { name: name ?? alt, kind }) } : {})}
      onMouseEnter={canHover ? () => setHover(true) : undefined}
      onMouseLeave={canHover ? () => setHover(false) : undefined}
    >
      {!show ? (
        placeholder ?? <span className="desk-grid block h-full w-full" />
      ) : kind === "image" ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={url} alt={alt ?? ""} draggable={false} className="h-full w-full object-cover" />
      ) : poster === "fail" ? (
        <video
          src={posterSrc(url)} muted preload="metadata" playsInline draggable={false}
          loop={canHover}
          onMouseEnter={canHover ? (e) => { e.currentTarget.play().catch(() => {}); } : undefined}
          onMouseLeave={canHover ? (e) => { const v = e.currentTarget; v.pause(); try { v.currentTime = 0.1; } catch { /* not seekable yet */ } } : undefined}
          className="h-full w-full object-cover"
        />
      ) : poster ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={poster} alt={alt ?? ""} draggable={false} className="h-full w-full object-cover" />
          {hover && (
            <video
              src={url} autoPlay muted loop playsInline draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
        </>
      ) : (
        placeholder ?? <span className="media-shimmer block h-full w-full" />
      )}
    </span>
  );
}
