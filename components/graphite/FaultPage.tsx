"use client";
import { useEffect, useRef } from "react";
import { TRAIL } from "@/components/ui/Mark";
import { HEADER_SEGMENT } from "@/lib/shell/ia";
import { FIND_HREF, STUDIO_HREF, TAKES_HREF, faultMessage, faultPrimary, faultRef, faultReport, isStaleBuild, segmentHref } from "@/lib/shell/fault";
import { Glyph, SUITE_LOOK } from "./icons";
import { CopyDetails, FaultIcon } from "./PanelFault";
import "@/app/graphite.css";
import "@/app/flair.css";
import "@/app/glass.css";
import "@/app/fault.css";

/**
 * The Suites header without the live shell behind it (Header.tsx needs the
 * shell's providers, which are exactly what failed or never loaded): the
 * mark, the six segments and Search, each a plain link that loads a clean
 * document. ⌘K works here too — it lands in the shell with search open.
 */
export function StaticHeader() {
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        window.location.assign(FIND_HREF);
      }
    };
    window.addEventListener("keydown", onKey);
    /* Says the shortcut is live (hydrated), for the browser specs. */
    header.current?.setAttribute("data-keys", "on");
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <header ref={header} className="gx-header" data-row="header" data-static="true">
      <div className="gx-aurora" aria-hidden="true" /><div className="gx-dots" aria-hidden="true" /><div className="gx-baseline" aria-hidden="true" />
      <a className="gx-brand" href={STUDIO_HREF} aria-label="particl home">
        <svg width="30" height="14" viewBox="30 68 140 64" fill="#F5F5F7" aria-hidden="true">
          <defs><linearGradient id="gx-mark-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F5F5F7" /><stop offset="1" stopColor="#6EB4FF" /></linearGradient></defs>
          {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
        </svg>
        <span className="gx-brand-name">particl</span>
      </a>
      <nav className="gx-seg" aria-label="Suites">
        {HEADER_SEGMENT.map((s) => (
          <a key={s.id} className="gx-seg-btn" href={segmentHref(s.id)} title={s.title} style={{ "--suite": SUITE_LOOK[s.id]?.color } as React.CSSProperties} data-suite-tab={s.id}>
            <Glyph name={SUITE_LOOK[s.id]?.glyph ?? "spark"} size={15} className="gx-glyph" />
            <span className="gx-seg-label">{s.label}</span>
            <span className="gx-sig" aria-hidden="true" />
          </a>
        ))}
      </nav>
      <a className="gx-search" href={FIND_HREF} aria-label="Search" aria-keyshortcuts="Meta+K" data-testid="header-search">
        <Glyph name="search" size={14} className="gx-glyph" />
        <span className="gx-search-label">Search</span>
        <span className="gx-key">⌘K</span>
      </a>
      <span className="gx-spacer" />
    </header>
  );
}

type PageError = Error & { digest?: string };

/**
 * One page for the two ways to land outside a working shell: the shell threw
 * (app/suites/error.tsx) or the link leads nowhere (app/not-found.tsx). Both
 * keep the header, so every suite is still one click away.
 */
export function FaultPage(props: { kind: "error"; error: PageError; onRetry: () => void } | { kind: "missing" }) {
  return (
    <div className="gx gx-outside" data-view="suite" data-suite="studio" data-testid={props.kind === "error" ? "suites-error" : "not-found"}>
      <StaticHeader />
      <main className="gx-outside-body">
        {props.kind === "error" ? <ShellFault error={props.error} onRetry={props.onRetry} /> : <Missing />}
      </main>
    </div>
  );
}

function ShellFault({ error, onRetry }: { error: PageError; onRetry: () => void }) {
  const stale = isStaleBuild(error);
  const reload = faultPrimary(error) === "reload";
  const message = faultMessage(error);
  const ref = faultRef(error);
  return (
    <section className="gx-fault" role="alert" aria-labelledby="gx-fault-title" data-fault="shell">
      <FaultIcon />
      <h1 className="gx-fault-title" id="gx-fault-title">This screen stopped</h1>
      <p className="gx-fault-sub">{stale ? "Particl was updated. Reload to carry on." : "Your work is safe. Renders in flight carry on."}</p>
      <div className="gx-fault-actions">
        {reload
          ? <button type="button" className="gx-primary" onClick={() => window.location.reload()} data-testid="fault-reload">Reload</button>
          : <button type="button" className="gx-primary" onClick={onRetry} data-testid="fault-retry">Try again</button>}
        {/* A hard load on purpose: the soft retry above re-enters the same tree; this fetches a clean one. */}
        <a className="gx-hbtn" href={STUDIO_HREF} data-testid="fault-studio">Back to Studio</a>
        <CopyDetails text={() => faultReport({ what: "The Suites shell", error, where: window.location.pathname + window.location.search })} />
      </div>
      <p className="gx-fault-ref" data-testid="fault-ref" title={message ?? undefined}>
        <span>ref {ref}</span>{message ? <span className="gx-fault-msg"> · {message}</span> : null}
      </p>
    </section>
  );
}

function Missing() {
  return (
    <section className="gx-fault" aria-labelledby="gx-fault-title" data-fault="missing">
      <FaultIcon tone="info" />
      <span className="gx-fault-eyebrow">404</span>
      <h1 className="gx-fault-title" id="gx-fault-title">Nothing here</h1>
      <p className="gx-fault-sub">The link is old, or what it pointed at was archived.</p>
      <div className="gx-fault-actions">
        <a className="gx-primary" href={STUDIO_HREF} data-testid="missing-studio">Back to Studio</a>
        <a className="gx-hbtn" href={TAKES_HREF} data-testid="missing-takes">Open Takes</a>
        <a className="gx-hbtn" href={FIND_HREF} aria-keyshortcuts="Meta+K" data-testid="missing-search">Search <span className="gx-fault-kbd">⌘K</span></a>
      </div>
    </section>
  );
}
