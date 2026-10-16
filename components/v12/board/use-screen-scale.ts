"use client";
import { useEffect, useState } from "react";
import { screenScale } from "@/lib/v12/board/screen-scale";

/** The board's screen scale (lib/v12/board/screen-scale.ts) for this window, followed as the window changes; 1 while off and before the window is known. */
export function useScreenScale(on: boolean): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!on) return;
    const read = () => setScale(screenScale(window.innerWidth, window.innerHeight));
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [on]);
  return on ? scale : 1;
}
