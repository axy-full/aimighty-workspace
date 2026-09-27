import type { CSSProperties, ReactNode } from "react";

/**
 * The public site's building blocks (app/marketing.css). Server components:
 * no state, so every page stays server-rendered and the only JavaScript sent
 * is the prompt bar, the access form and the pricing toggle.
 */

type Col = { col?: number };
const colStyle = (col?: number): CSSProperties | undefined =>
  col ? ({ "--mk-col": `${col}px` } as CSSProperties) : undefined;

export function Section({ id, panel, label, className = "", style, children }: {
  id?: string; panel?: boolean; label?: string; className?: string; style?: CSSProperties; children: ReactNode;
}) {
  return (
    <section id={id} aria-label={label} className={`mk-section${panel ? " mk-section--panel" : ""} ${className}`} style={style}>
      <div className="mk-wrap">{children}</div>
    </section>
  );
}

export function Head({ eyebrow, title, lead, as = "h2", aside, center }: {
  eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; as?: "h1" | "h2" | "h3"; aside?: ReactNode; center?: boolean;
}) {
  const H = as;
  const head = (
    <div className="mk-head" style={center ? { alignItems: "center", textAlign: "center" } : undefined}>
      {eyebrow && <div className="mk-eyebrow">{eyebrow}</div>}
      <H className={as === "h3" ? "mk-h3" : "mk-h2"}>{title}</H>
      {lead && <p className="mk-lead">{lead}</p>}
    </div>
  );
  if (!aside) return head;
  return <div className="mk-head--row mk-head">{head}{aside}</div>;
}

export function Grid({ col, className = "", style, children }: Col & { className?: string; style?: CSSProperties; children: ReactNode }) {
  return <div className={`mk-grid ${className}`} style={{ ...colStyle(col), ...style }}>{children}</div>;
}

export function Cols({ col, className = "", style, children }: Col & { className?: string; style?: CSSProperties; children: ReactNode }) {
  return <div className={`mk-cols ${className}`} style={{ ...colStyle(col), ...style }}>{children}</div>;
}

/** A tile: tag, name, body and an optional price row. */
export function Tile({ tag, badge, name, sub, body, price, priceNote, children, className = "" }: {
  tag?: ReactNode; badge?: ReactNode; name?: ReactNode; sub?: ReactNode; body?: ReactNode; price?: ReactNode; priceNote?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <div className={`mk-card ${className}`}>
      {(tag || badge) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          {tag && <span className="mk-tag">{tag}</span>}
          {badge}
        </div>
      )}
      {name && <div className="mk-name">{name}</div>}
      {sub && <span className="mk-role">{sub}</span>}
      {body && <p className="mk-body">{body}</p>}
      {children}
      {price != null && (
        <div className="mk-price-row">
          <span className="mk-price">{price}</span>
          {priceNote && <span className="mk-price-note">{priceNote}</span>}
        </div>
      )}
    </div>
  );
}

/** A figure tile: a big mono number and what it means. */
export function Stat({ figure, name, body }: { figure: ReactNode; name: ReactNode; body?: ReactNode }) {
  return (
    <div className="mk-card">
      <span className="mk-stat">{figure}</span>
      <div className="mk-name" style={{ fontSize: 17 }}>{name}</div>
      {body && <p className="mk-body">{body}</p>}
    </div>
  );
}

export function Note({ lead, children }: { lead?: ReactNode; children: ReactNode }) {
  return <p className="mk-note">{lead && <strong>{lead} </strong>}{children}</p>;
}

export function Fact({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="mk-fact">
      <span className="mk-fact-k">{k}</span>
      <span className="mk-fact-v">{v}</span>
    </div>
  );
}

export function Chips({ items, tint }: { items: ReactNode[]; tint?: boolean }) {
  return (
    <div className="mk-chips">
      {items.map((item, i) => <span key={i} className={`mk-chip${tint ? " mk-chip--tint" : ""}`}>{item}</span>)}
    </div>
  );
}

export const Amber = ({ children }: { children: ReactNode }) => <span className="mk-amber">{children}</span>;
export const Green = ({ children }: { children: ReactNode }) => <span className="mk-green">{children}</span>;
export const Dot = ({ state }: { state: "done" | "run" | "idle" }) => <span className={`mk-dot mk-dot--${state}`} aria-hidden="true" />;

/** A group card: a head, then rows of name · chip · description. */
export function Group({ tag, note, rows }: {
  tag: ReactNode; note?: ReactNode;
  rows: { name: ReactNode; chip?: ReactNode; desc?: ReactNode; badge?: ReactNode }[];
}) {
  return (
    <div className="mk-group">
      <div className="mk-group-head">
        <span className="mk-tag">{tag}</span>
        {note && <span className="mk-group-note">{note}</span>}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="mk-group-row">
          <span className="mk-group-name">{row.name}</span>
          <span style={{ display: "inline-flex", gap: 6 }}>
            {row.badge}
            {row.chip && <span className="mk-chip">{row.chip}</span>}
          </span>
          {row.desc && <p className="mk-group-desc">{row.desc}</p>}
        </div>
      ))}
    </div>
  );
}

/** A product window: a title bar and a screenshot of the app. */
export function Window({ path, src, alt, width = 924, height = 578, priority }: {
  path: string; src: string; alt: string; width?: number; height?: number; priority?: boolean;
}) {
  return (
    <figure className="mk-window" style={{ margin: 0 }}>
      <div className="mk-window-bar" aria-hidden="true">
        <i /><i /><i />
        <span className="mk-window-path">{path}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- static screenshots, already sized */}
      <img src={src} alt={alt} width={width} height={height} loading={priority ? "eager" : "lazy"} decoding="async" />
    </figure>
  );
}

/** The header every suite page but Gen opens with. */
export function SuiteHeader({ eyebrow, title, lead, pages, cta }: {
  eyebrow: ReactNode; title: ReactNode; lead: ReactNode; pages: string[]; cta?: ReactNode;
}) {
  return (
    <section className="mk-suite-head">
      <div className="mk-wrap">
        <div className="mk-eyebrow">{eyebrow}</div>
        <h1 className="mk-h1">{title}</h1>
        <p className="mk-lead">{lead}</p>
        <div className="mk-pages">
          {pages.map((page, i) => (
            <span key={page} className="mk-page"><b>{String(i + 1).padStart(2, "0")}</b>{page}</span>
          ))}
        </div>
        {cta && <div className="mk-cta">{cta}</div>}
      </div>
    </section>
  );
}
