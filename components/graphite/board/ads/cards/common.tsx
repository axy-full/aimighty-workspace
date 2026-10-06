"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import LazyMedia from "@/components/LazyMedia";
import type { Row } from "../ads-model";

/* The Ads and Social cards' shared parts (frames "Ads and Social frames": the 308 px card, its tag on the media, rows of label and mono value, buttons). */

/** A button on a card: outlined, or tinted when it is the card's next step. `nodrag nopan` keeps a press from starting a canvas drag or pan. */
export function Btn({ primary, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" {...rest} className={`ab-btn nodrag nopan${className ? ` ${className}` : ""}`} data-primary={primary || undefined} />;
}

/** The media well: a still or a video with its tag at the top left, or the card's empty well. */
export function Well({ url, media, tag, height, empty, children }: { url: string | null; media?: "image" | "video"; tag?: string; height: number; empty?: string; children?: ReactNode }) {
  return (
    <span className="ab-well" style={{ height }}>
      {url && media === "video" ? <LazyMedia url={url} kind="video" preview={false} />
        /* eslint-disable-next-line @next/next/no-img-element */
        : url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : empty ? <span className="ab-well-empty">{empty}</span> : null}
      {tag ? <span className="ab-tag">{tag}</span> : null}
      {children}
    </span>
  );
}

export function Rows({ rows, testId }: { rows: readonly Row[]; testId?: string }) {
  return (
    <dl className="ab-rows" data-testid={testId}>
      {rows.map((row, i) => (
        <div className="ab-row" key={`${row.label}:${i}`}>
          <dt>{row.label}</dt>
          <dd data-mono={row.mono || undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const Title = ({ children }: { children: ReactNode }) => <span className="ab-title">{children}</span>;
export const Meta = ({ children }: { children: ReactNode }) => <span className="ab-meta">{children}</span>;
export function Actions({ children }: { children: ReactNode }) {
  return <div className="ab-actions">{children}</div>;
}
/** A state line: a problem or a wait, in words. */
export const Note = ({ children, tone, role }: { children: ReactNode; tone?: "bad"; role?: "alert" | "status" }) => <p className="ab-note" data-tone={tone} role={role}>{children}</p>;
