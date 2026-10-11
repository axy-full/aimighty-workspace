import type { ReactNode } from "react";

/** A shortcut key, or a run of them ("⌘K", or ["G", "H"] for a sequence). Mono 12 px, the floor. */
export function Kbd({ keys, children }: { keys?: string | readonly string[]; children?: ReactNode }) {
  const list = keys === undefined ? null : typeof keys === "string" ? [keys] : keys;
  if (!list) return <kbd className="v12-kbd">{children}</kbd>;
  return (
    <span className="v12-kbds">
      {list.map((key, i) => <kbd key={`${key}-${i}`} className="v12-kbd">{key}</kbd>)}
    </span>
  );
}
