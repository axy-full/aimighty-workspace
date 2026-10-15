"use client";
import Link from "next/link";
import { useId } from "react";
import { AGE_CONFIRM_LABEL } from "@/lib/ageConfirm";
import "./age-confirm.css";

/**
 * The 18+ tick at every sign-up screen (lib/ageConfirm.ts): one required checkbox, one plain sentence, "Terms" a link to the Terms page. The whole row is the target (44 px high),
 * the box has a visible focus ring, and the sentence is its accessible name. `name`/`value` make it a form field where the screen posts a plain form (Continue with Google).
 */
const [BEFORE, AFTER] = AGE_CONFIRM_LABEL.split("Terms");

export function AgeConfirm({ checked, onChange, testId, name, className = "" }: {
  checked?: boolean; onChange?: (checked: boolean) => void; testId?: string; name?: string; className?: string;
}) {
  const id = useId();
  return (
    <label className={`age-confirm ${className}`.trim()} htmlFor={id} data-testid={testId ? `${testId}-row` : undefined}>
      <input id={id} type="checkbox" required className="age-confirm-box" name={name} value={name ? "1" : undefined}
        {...(checked === undefined ? {} : { checked, onChange: (e) => onChange?.(e.target.checked) })} data-testid={testId} />
      <span>{BEFORE}<Link className="age-confirm-link" href="/terms" target="_blank" rel="noopener">Terms</Link>{AFTER}</span>
    </label>
  );
}
