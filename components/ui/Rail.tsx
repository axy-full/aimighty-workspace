import type { ReactNode } from "react";

/**
 * The right rail (design/particl-v2/README.md §3, §5; board 10a): `#0F1116`
 * with a 1px `--border-mid` left edge (§3 names the token; 10a draws it
 * at .12), a 52px header (`gap 8px`, `0 14px` at 300
 * wide, `0 16px` at 420, a .08 hairline beneath), a scrolling body (a
 * column, `gap 12px`, padded `14px` at 300 and `14px 16px 12px` at 420),
 * and a pinned footer (a .08 hairline above, `gap 8px`; a row padded
 * `10px 14px 14px` at 300, a column padded `10px 16px 16px` at 420).
 *
 * Layout only. It does not know what is in it, and it does not know how to
 * open or close — the shell owns that state (§5).
 *
 * In a short window (a phone held landscape) the header and the pinned
 * footer can be taller than the rail itself: there the rail scrolls as one
 * column, so the footer is reached inside it instead of running on under
 * what follows the rail (a page's dock). Only there: elsewhere the resize
 * handle straddles the rail's edge, and a scrolling box would clip it.
 */
export const RAIL_WIDTHS = { compact: 300, expanded: 420 } as const;

type Props = {
  width: number;
  resizeHandle?: ReactNode;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  label: string;
  className?: string;
};

export default function Rail({ width, resizeHandle, header, footer, children, label, className = "" }: Props) {
  const wide = width >= RAIL_WIDTHS.expanded;
  return (
    <aside aria-label={label} style={{ width,position:"relative" }}
      className={`ui-rail flex h-full flex-none flex-col border-l border-border-mid text-ink [@media(max-height:500px)]:overflow-y-auto ${className}`}>
      {resizeHandle}
      <header className={`flex h-[52px] flex-none items-center gap-[8px] border-b border-border ${wide ? "px-[16px]" : "px-[14px]"}`}>{header}</header>
      <div className={`flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto ${wide ? "px-[16px] pb-[12px] pt-[14px]" : "p-[14px]"}`}>{children}</div>
      {footer && (
        <footer className={`flex flex-none gap-[8px] border-t border-border pt-[10px] ${wide ? "flex-col px-[16px] pb-[16px]" : "px-[14px] pb-[14px]"}`}>{footer}</footer>
      )}
    </aside>
  );
}
