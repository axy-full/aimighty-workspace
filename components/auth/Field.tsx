"use client";

import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";

/**
 * One field (board 12i): a 46px input on `--ground`, 1px `--border-mid`,
 * radius 10, `0 14px`, Outfit 400 14px — 16px below 768 so iOS does not
 * zoom. The board draws no label above it: the label is the prompt inside
 * the field, and stays on the element for assistive tech and for a test's
 * getByLabel. Focus raises the border alpha, nothing else. The input is the
 * target, so it needs no tap44. `trailing` sits inside the field's right
 * edge (the password field's Show).
 */
export const INPUT = "box-border h-[46px] w-full rounded-tile border border-border-mid bg-ground px-[14px] text-[14px] leading-none text-ink outline-0 placeholder:text-ink-muted focus:border-border-hover max-md:text-[16px]";

type Props = { label: string; trailing?: ReactNode } & ComponentPropsWithoutRef<"input">;

export default function Field({ label, trailing, id, className = "", ...input }: Props) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="flex flex-col">
      <label htmlFor={inputId} className="sr-only">{label}</label>
      <div className="relative">
        <input id={inputId} placeholder={label} className={`${INPUT} ${trailing ? "pr-[72px]" : ""} ${className}`} {...input} />
        {trailing && <span className="absolute inset-y-0 right-0 flex items-center">{trailing}</span>}
      </div>
    </div>
  );
}
