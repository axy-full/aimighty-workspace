"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitWords } from "@/lib/v12/home";

/**
 * One line of words that always fits: whole when there is room, else cut at a word with an ellipsis (lib/v12/home.ts
 * fitWords). It replaces the stylesheet's text-overflow, which cuts in the middle of a word. The room is the element's own
 * width, or `box`'s (the nearest ancestor matching that selector) less `inset`, for a label whose own width follows its words.
 * The full words are the hover when they are cut.
 */
export function FitText({ text, className, box, inset = 0 }: { text: string; className?: string; box?: string; inset?: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  const measure = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    measure.current = () => {
      const holder = box ? node.closest<HTMLElement>(box) : node;
      const avail = (holder?.clientWidth ?? 0) - (box ? inset : 0);
      const style = getComputedStyle(node);
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx || avail <= 0) { setShown(text); return; }
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const space = Number.parseFloat(style.letterSpacing) || 0;
      setShown(fitWords(text, avail, (t) => ctx.measureText(t).width + space * t.length));
    };
    measure.current();
  }, [text, box, inset]);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const holder = box ? node.closest<HTMLElement>(box) : node;
    if (!holder) return;
    const seen = new ResizeObserver(() => measure.current());
    seen.observe(holder);
    void document.fonts?.ready.then(() => measure.current());
    return () => seen.disconnect();
  }, [box]);
  return (
    <span ref={el} className={className} title={shown === text ? undefined : text}>{shown}</span>
  );
}
