import type { ReactNode } from "react";
import { Mono } from "@/components/ui";

/** The card's eyebrow: Kode Mono 11px .12em uppercase in `--ink-muted`. */
export default function Eyebrow({ children }: { children: ReactNode }) {
  return <Mono as="div">{children}</Mono>;
}
