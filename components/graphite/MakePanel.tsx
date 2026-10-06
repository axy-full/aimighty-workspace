"use client";
import { useState } from "react";
import { wantsChange } from "@/lib/shell/make";
import { Make, type MakeProps } from "./make/Make";

/**
 * Make, as the handoff draws it (design/particl-graphite/README.md § 3.2): a panel over any screen, full width on a phone
 * (components/graphite/make/Make.tsx). Release 1 has one Make; the old panel and the Gen page are gone.
 */
export function MakePanel(props: MakeProps) {
  /* `make=change` asks for the engine list open. The shell names the type in the address once it has landed, so the
     ask is read here, on the first render, before that. */
  const [change] = useState(() => typeof window !== "undefined" && wantsChange(window.location.search));
  return <Make {...props} listOpen={change} />;
}
