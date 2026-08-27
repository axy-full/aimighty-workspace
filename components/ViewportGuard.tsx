"use client";

import { useEffect } from "react";

/**
 * iOS's on-screen keyboard shrinks the *visual* viewport but not 100dvh, and
 * Safari "helpfully" pans the whole fixed shell to reveal the caret. Track
 * the keyboard height into --kb (consumed by .compose and the chat panel)
 * and cancel the pan so the app chrome stays put.
 */
export default function ViewportGuard() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      // Pinch-zoom also shrinks the visual viewport — that's not a keyboard.
      const zoomed = (vv.scale ?? 1) > 1.02;
      const kb = zoomed ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty("--kb", `${kb}px`);
      if (kb > 0) window.scrollTo(0, 0);
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
      document.documentElement.style.removeProperty("--kb");
    };
  }, []);
  return null;
}
