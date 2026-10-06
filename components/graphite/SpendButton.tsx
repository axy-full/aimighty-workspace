import type { ButtonHTMLAttributes } from "react";
import { priceLabel, spendAttrs, type SpendPrice } from "@/lib/spend";

/**
 * A button that spends credits: what it does, then what it costs ("Make · 43 cr"). It carries `data-spend`, which is
 * what the price checks look for (docs/ui-checks.md), and it stays disabled until there is a price. The price is
 * its own run of text so a narrow button moves it whole onto a second line and never cuts it.
 *
 * Pass the server's quote as `price`. `busy` is a submission in flight: the button is disabled and says so.
 */
export type SpendButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  price: SpendPrice;
  busy?: boolean;
  busyLabel?: string;
};

export function SpendButton({ label, price, busy = false, busyLabel = "Submitting…", disabled, type = "button", ...rest }: SpendButtonProps) {
  const text = priceLabel(price);
  const attrs = spendAttrs(price);
  return (
    <button
      type={type}
      {...rest}
      {...attrs}
      disabled={disabled || busy || attrs.disabled}
      aria-label={busy ? busyLabel : text ? `${label} · ${text}` : label}
      aria-busy={busy || undefined}
      data-priced={text && !busy ? "" : undefined}
    >
      {busy ? busyLabel : (
        <>
          <span className="gx-go-act">{label}</span>
          {text ? <span className="gx-go-price"><span className="gx-go-sep">{" · "}</span>{text}</span> : null}
        </>
      )}
    </button>
  );
}
