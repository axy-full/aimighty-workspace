"use client";

import { useState, type ComponentPropsWithoutRef } from "react";
import Field from "./Field";

/**
 * One password field with a Show toggle in place of a confirm field: what
 * is typed can be read back, so it need not be typed twice. The toggle is
 * the field's own height (46px), so it is a target on the phone.
 */
type Props = { label?: string } & Omit<ComponentPropsWithoutRef<"input">, "type">;

export default function PasswordField({ label = "Password", autoComplete = "new-password", ...input }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} type={shown ? "text" : "password"} autoComplete={autoComplete} spellCheck={false} {...input}
      trailing={
        <button type="button" onClick={() => setShown((s) => !s)} aria-pressed={shown}
          className="ui-mono h-[46px] px-[14px] text-ink-muted">
          {shown ? "Hide" : "Show"}
        </button>
      } />
  );
}
