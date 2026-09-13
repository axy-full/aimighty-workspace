"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui";

/**
 * The card's one primary (board 12i): Button in its `auth` placement —
 * 46px, radius 10, ink on ground, Outfit 600 14px, full width, a submit.
 * Busy shows the 14px ring on ground inside the fill and never the string
 * "…". A cost, when it carries one, sits right in mono; without one the
 * label is centred.
 */
type Props = Omit<ComponentProps<typeof Button>, "variant" | "placement">;

export default function Primary({ className = "", cost, type = "submit", ...rest }: Props) {
  return (
    <Button variant="primary" placement="auth" type={type} cost={cost}
      className={`${cost === undefined ? "!justify-center" : ""} ${className}`} {...rest} />
  );
}
