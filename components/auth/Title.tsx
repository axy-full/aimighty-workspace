import type { ReactNode } from "react";

/** The card's title: Outfit 600 22px/1.15 in `--ink`. */
export default function Title({ children }: { children: ReactNode }) {
  return <h1 className="m-0 text-[22px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink [overflow-wrap:anywhere]">{children}</h1>;
}
