import type { ReactNode } from "react";

/** What went wrong, inline under the primary: 13px in `--color-lift`. */
export default function ErrorLine({ children }: { children: ReactNode }) {
  return <p role="alert" className="m-0 text-[13px] leading-[1.45] text-lift [overflow-wrap:anywhere]">{children}</p>;
}
