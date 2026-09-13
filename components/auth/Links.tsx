"use client";

import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * The small ways out of a card, in mono: `← SIGN IN`, `REQUEST AN INVITE`.
 * Each is a 44px target below 768 (tap44) on an 11px line.
 */
export const LINK = "ui-mono tap44 inline-flex items-center text-ink-muted";

export function Links({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center justify-between gap-x-[14px] gap-y-[8px] ${className}`}>{children}</div>;
}

export function AuthLink({ className = "", ...rest }: ComponentPropsWithoutRef<typeof Link>) {
  return <Link className={`${LINK} ${className}`} {...rest} />;
}

/** The same line as a button, for a step back or a dialog. */
export function AuthLinkButton({ className = "", type = "button", ...rest }: ComponentPropsWithoutRef<"button">) {
  return <button type={type} className={`${LINK} ${className}`} {...rest} />;
}
