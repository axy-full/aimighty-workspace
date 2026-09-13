"use client";

import type { ComponentPropsWithoutRef, FormEvent } from "react";

/**
 * The card itself (board 12i): `--card` on a 1px `rgba(245,246,248,.1)`
 * edge — the board's alpha, which no token names — radius 14, padding 24,
 * a 14px gap between rows. With `onSubmit` the card IS the form, so a
 * screen's fields and its one primary sit in the same column with nothing
 * between them; other attributes (a `data-onboarding` hook) land on it too.
 * The form posts: an Enter before hydration must never carry a password
 * into the URL, the history or a request log.
 */
export type CardProps = Omit<ComponentPropsWithoutRef<"form">, "onSubmit"> & {
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
};

const CARD = "flex w-full flex-col gap-[14px] rounded-[14px] border border-[rgba(245,246,248,.1)] bg-card p-[24px]";

export default function Card({ onSubmit, className = "", children, ...rest }: CardProps) {
  if (onSubmit) {
    return <form method="post" onSubmit={onSubmit} className={`${CARD} ${className}`} {...rest}>{children}</form>;
  }
  return <div className={`${CARD} ${className}`} {...(rest as ComponentPropsWithoutRef<"div">)}>{children}</div>;
}
