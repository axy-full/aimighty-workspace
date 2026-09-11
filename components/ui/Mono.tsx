import type { ElementType, HTMLAttributes } from "react";

/**
 * The mono label (design/particl-v2/README.md §2): Kode Mono 500, 11px,
 * uppercase, .12em — eyebrows, IDs (`SH04`), states (`PICKED`), engine
 * names, timestamps. A cost (`19 CR`) tightens to .08em. Muted by default
 * because most of these are labels; pass `tone="ink"` for a readout.
 */
type Props = {
  as?: ElementType;
  cost?: boolean;
  tone?: "muted" | "body" | "ink";
} & HTMLAttributes<HTMLElement>;

const TONE = { muted: "text-ink-muted", body: "text-ink-body", ink: "text-ink" } as const;

export default function Mono({ as: Tag = "span", cost, tone = "muted", className = "", ...rest }: Props) {
  return <Tag className={`ui-mono ${cost ? "ui-mono-cost" : ""} ${TONE[tone]} ${className}`} {...rest} />;
}
