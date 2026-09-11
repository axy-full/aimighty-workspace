import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Pill chip (design/particl-v2/README.md §3): 1px `--border-mid`, 999
 * radius, 12–13px. The boards cut it seven ways, and each is copied at its
 * own numbers:
 *
 *   pill      `Rig · 12 assets` (7a): 32px, `0 12px`, .14, Outfit 500 12.5px, `--ink-body`
 *   need      `3 need you` on a production row (7a): 30px, `0 10px`, .14, 500 12.5px, ink, a 7px
 *             ink dot 7px before it; `needHeader` is the production header's cut (7b): 34px,
 *             `0 12px`, 500 13px, an 8px dot 8px before it
 *   filter    `Takes · 22` (7b): `8px 11px`, .12, 500 12.5px, `--ink-body` (`tone="ink"` for the
 *             Library's, 8b); active fills .1 in ink
 *   composer  `Push in`, `50mm` (8a): `6px 9px`, .12, 500 12px, ink
 *   dashed    `+ Row`, `+ Add` (8a): `6px 9px`, dashed .22, 500 12px, `--ink-body` — a slot for what is not there yet
 *   mono      `30S HERO · RUN 02 · 3 OF 8` (10a): `7px 10px`, .14, mono, `gap 8px`
 *   scrim     the ID and state chips over media (10a): `rgba(11,13,17,.85)`, radius 4, `4px 6px`, mono in
 *             the caller's colour — ink for an ID, the state's colour for a state, accent for `↓ 1080P`
 *
 * A count sits in the label at the chip's own size (`Takes · 22`) — no
 * board puts a mono span inside an Outfit pill. Renders a button when given
 * `onClick`, a span otherwise, so a chip that does nothing is not announced
 * as something to press.
 */
type Variant = "pill" | "need" | "needHeader" | "filter" | "composer" | "dashed" | "mono" | "scrim";

type Base = {
  variant?: Variant;
  /** The filter's text: `--ink-body` on the kind filters (7b), ink on the Library's (8b). */
  tone?: "body" | "ink";
  /** Selected: the filter's .1 fill in ink. */
  active?: boolean;
  children: ReactNode;
  className?: string;
};
type Props = Base & (
  | ({ onClick: () => void } & Omit<ComponentPropsWithoutRef<"button">, "onClick" | "children" | "className">)
  | ({ onClick?: undefined } & Omit<ComponentPropsWithoutRef<"span">, "children" | "className">)
);

const LOOK: Record<Variant, string> = {
  pill: "h-[32px] rounded-pill border border-border-mid px-[12px] text-[12.5px] font-medium text-ink-body",
  need: "h-[30px] gap-[7px] rounded-pill border border-border-mid px-[10px] text-[12.5px] font-medium text-ink",
  needHeader: "h-[34px] gap-[8px] rounded-pill border border-border-mid px-[12px] text-[13px] font-medium text-ink",
  filter: "rounded-pill border border-[rgba(245,246,248,.12)] px-[11px] py-[8px] text-[12.5px] font-medium",
  composer: "rounded-pill border border-[rgba(245,246,248,.12)] px-[9px] py-[6px] text-[12px] font-medium text-ink",
  dashed: "rounded-pill border border-dashed border-[rgba(245,246,248,.22)] px-[9px] py-[6px] text-[12px] font-medium text-ink-body",
  mono: "gap-[8px] rounded-pill border border-border-mid px-[10px] py-[7px] text-ink",
  scrim: "ui-chip-scrim gap-[6px] rounded-badge px-[6px] py-[4px]",
};

export default function Chip({ variant = "pill", tone = "body", active, children, className = "", ...rest }: Props) {
  const isMono = variant === "mono" || variant === "scrim";
  const cls = `inline-flex items-center whitespace-nowrap leading-none ${LOOK[variant]} ${
    variant === "filter" ? (tone === "ink" ? "text-ink" : "text-ink-body") : ""} ${
    active ? "bg-[rgba(245,246,248,.1)] text-ink" : ""} ${
    rest.onClick ? "tap44 hover:border-border-hover" : ""} ${className}`;
  const dot = variant === "need" ? 7 : variant === "needHeader" ? 8 : 0;
  const body = (
    <>
      {dot > 0 && <span aria-hidden="true" className="block flex-none rounded-full bg-ink" style={{ width: dot, height: dot }} />}
      {isMono ? <span className="ui-mono">{children}</span> : children}
    </>
  );
  if (rest.onClick) {
    const { onClick, ...btn } = rest as Extract<Props, { onClick: () => void }>;
    return <button type="button" onClick={onClick} aria-pressed={active} className={cls} {...btn}>{body}</button>;
  }
  const { onClick: _skip, ...span } = rest as Extract<Props, { onClick?: undefined }>;
  void _skip;
  return <span className={cls} {...span}>{body}</span>;
}
