"use client";

import type { ReactNode } from "react";
import ParticlLockup from "@/components/ParticlMark";
import { PageLoader } from "@/components/atomik/Loader";
import Card, { type CardProps } from "./Card";

/**
 * The auth screen (board 12i): the page ground, one card centred at 400px,
 * the lockup at 22 above it. Below 768 the card runs full width inside
 * 16px gutters. The primary stays inside the card on the phone — a
 * one-field card with the keyboard up keeps its button beside the field —
 * so there is no pinned bar here.
 */
export default function AuthFrame({ children, ...card }: CardProps) {
  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-[16px] py-[40px] text-ink">
      <div className="flex w-full max-w-[400px] flex-col gap-[18px]">
        <ParticlLockup size={22} className="px-[2px]" />
        <Card {...card}>{children}</Card>
      </div>
    </div>
  );
}

/** While a link or an invitation is being checked: the ring, and one mono line. Never the string "…". */
export function AuthChecking({ what }: { what: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-[16px] text-ink">
      <PageLoader what={what} />
    </div>
  );
}
