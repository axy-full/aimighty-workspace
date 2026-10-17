"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { coverWidth, imageSizes, imageSrcSet } from "@/lib/imageTiers";

type Box = { width: number; height: number };
/** A box measured on screen, kept only when it is drawn and has changed by a pixel or more, so measuring again never re-renders for nothing. */
const nextBox = (r: Box) => (b: Box | null): Box | null =>
  !(r.width > 0 && r.height > 0) || (b && Math.abs(b.width - r.width) < 1 && Math.abs(b.height - r.height) < 1) ? b : { width: r.width, height: r.height };
/* Server rendering has no layout: the effect runs after hydration there, as it must. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * An <img> of a Particl still at the size the screen needs (lib/imageTiers.ts; owner, 16 Oct 2026, 15:05): its width tiers in `srcset`,
 * `sizes` the width the file is drawn at, measured on screen (a zoomed board counts; a cover crop wider than its box counts once the
 * picture's shape is known) and measured again when the window or the box changes size. The browser multiplies `sizes` by the
 * screen's pixel ratio, so a 2x screen gets two file pixels per CSS pixel and a small tile does not fetch the original.
 *
 * Nothing is fetched until the box is measured (before the first paint), so the browser chooses once, from the right `sizes`, and
 * never fetches the original and a tier both. A box with no size of its own yet is measured as the window. A tier that will not load
 * falls back to the original, and only the original failing calls `onError`. Any other URL (a vendor's, a data: URL, a file under
 * /public) is an ordinary <img>. The element, its classes and its layout are the caller's, unchanged.
 */
export default function TieredImg({ src, alt, onError, onLoad, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes" | "alt"> & { src: string | null | undefined; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  /* Keyed by src: a new picture gets its tiers again. */
  const [plainFor, setPlainFor] = useState<string | null>(null);
  const srcSet = !src || plainFor === src ? undefined : imageSrcSet(src);
  const [box, setBox] = useState<Box | null>(null);
  const [measured, setMeasured] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  /* Only a cover crop draws the file wider than its box; contain and fill draw it no wider. */
  const [cover, setCover] = useState(false);

  useBeforePaint(() => {
    if (!srcSet) return;
    const el = ref.current;
    if (!el) return;
    setBox(nextBox(el.getBoundingClientRect()));
    setCover(getComputedStyle(el).objectFit === "cover");
    setMeasured(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => setBox(nextBox(el.getBoundingClientRect())), 250); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(later) : null;
    ro?.observe(el);
    window.addEventListener("resize", later);
    return () => { clearTimeout(timer); ro?.disconnect(); window.removeEventListener("resize", later); };
  }, [srcSet]);

  if (!srcSet) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img ref={ref} src={src || undefined} alt={alt} onError={onError} onLoad={onLoad} {...rest} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={ref} alt={alt} {...rest}
      sizes={measured ? imageSizes(cover ? coverWidth(box, aspect) : box?.width) : undefined} srcSet={measured ? srcSet : undefined} src={measured ? src ?? undefined : undefined}
      onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth > 0 && i.naturalHeight > 0) setAspect(i.naturalWidth / i.naturalHeight); onLoad?.(e); }}
      onError={() => setPlainFor(src ?? null)} />
  );
}
