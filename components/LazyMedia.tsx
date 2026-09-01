"use client";

import { useEffect, useRef, useState } from "react";
import { posterSrc } from "@/lib/format";

/**
 * Grids used to mount a <video preload="metadata"> for every card at once, so
 * opening a library of 500 clips fired 500 media requests — each of which
 * makes the server fetch a whole file to answer. A page of thumbnails could
 * pull gigabytes and wedge a phone's tab.
 *
 * Media now mounts only once its card is near the viewport, and stays mounted
 * afterwards so scrolling back is instant. What loads is what you looked at.
 */
export default function LazyMedia({
  url, kind, alt, className = "", placeholder,
}: {
  url: string;
  kind: "video" | "image";
  alt?: string;
  className?: string;
  placeholder?: React.ReactNode;
}) {
  const holder = useRef<HTMLSpanElement>(null);
  // Browsers without IntersectionObserver just show everything, as before.
  const [show, setShow] = useState(
    () => typeof IntersectionObserver === "undefined" && typeof window !== "undefined"
  );

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

  return (
    <span ref={holder} className={`block h-full w-full ${className}`}>
      {show ? (
        kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={url} alt={alt ?? ""} draggable={false} className="h-full w-full object-cover" />
        ) : (
          <video
            src={posterSrc(url)} muted preload="metadata" playsInline draggable={false}
            className="h-full w-full object-cover"
          />
        )
      ) : (
        placeholder ?? <span className="desk-grid block h-full w-full" />
      )}
    </span>
  );
}
