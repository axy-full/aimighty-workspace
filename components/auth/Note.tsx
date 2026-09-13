import type { ReactNode } from "react";

/** A line of prose in the card: 13.5px/1.5 in `--ink-body` — or in `--ink` when it is the one line that matters. */
export default function Note({ children, className = "", tone = "body" }: { children: ReactNode; className?: string; tone?: "body" | "ink" }) {
  return <p className={`m-0 text-[13.5px] leading-[1.5] ${tone === "ink" ? "text-ink" : "text-ink-body"} [overflow-wrap:anywhere] ${className}`}>{children}</p>;
}
