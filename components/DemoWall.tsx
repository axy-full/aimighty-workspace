"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import LazyMedia from "@/components/LazyMedia";

type DemoTake = { key: string; shotCode: string; version: number; resolution: string; duration: number; prompt: string; credits: number; approved: boolean; url: string; move: string };
type Demo = {
  production: {
    name: string; code: string; description: string;
    cast: { name: string; kind: string; description: string }[];
    shots: { code: string; title: string; description: string; planned: number; setupLine: string }[];
    takes: DemoTake[];
  };
};

/**
 * The demo production, read-only (brief 1.7): proof it works, signed out —
 * three shots, their takes, one Approved, the credits each one cost. The
 * composer stays where it is: sign in to render.
 */
export default function DemoWall({ compact = false }: { compact?: boolean }) {
  /* Fetched here rather than through useApi, which stays quiet when signed out: this wall is FOR the signed-out. */
  const [data, setData] = useState<Demo | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/platform/demo", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j) setData(j as Demo); }).catch(() => {});
    return () => { live = false; };
  }, []);
  /* The demo's takes arrive already priced in credits — the server does the
     conversion, because doing it here needed the margin table to be here, and
     this is a page a visitor can open. */
  const cr = (n: number) => `${Math.round(n).toLocaleString("en-US")} cr`;
  if (!data) return null;
  const p = data.production;
  const spent = p.takes.reduce((a, t) => a + t.credits, 0);
  return (
    <section id="demo" className={`demo ${compact ? "is-compact" : ""}`} aria-label="Demo production">
      <div className="demo-head">
        <span className="mono-s">{p.code} · DEMO PRODUCTION · READ-ONLY</span>
        <span className="demo-title">{p.name}</span>
        <span className="demo-line">{p.description}</span>
        <span className="demo-meta">{p.shots.length} shots · {p.takes.length} takes · {p.takes.filter((t) => t.approved).length} approved · {cr(spent)} spent · cast: {p.cast.map((c) => `@${c.name}`).join(", ")}</span>
      </div>
      {p.shots.map((s) => {
        const takes = p.takes.filter((t) => t.shotCode === s.code);
        return (
          <div key={s.code} className="demo-shot">
            <div className="demo-shot-head">
              <span className="mono-s">{s.code}</span>
              <span className="demo-shot-title">{s.title}</span>
              <span className="demo-shot-setup">{s.setupLine}.</span>
            </div>
            <div className="demo-grid">
              {takes.map((t) => (
                <div key={t.key} className={`demo-take ${t.approved ? "is-approved" : ""}`}>
                  <div className="demo-take-media"><LazyMedia url={t.url} kind="video" hoverPlay className="h-full w-full object-cover" /></div>
                  <div className="demo-take-foot">
                    <span className="mono-s">v{t.version} · {t.resolution.toUpperCase()} · {t.duration}s · {t.move}</span>
                    <span className="demo-take-cost">{t.approved ? "Approved · " : ""}{cr(t.credits)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="demo-foot">Generic footage (Big Buck Bunny, CC BY) stands in for the takes until the platform&rsquo;s own previews are published. <Link href="/welcome" className="hdr-mono-link">SIGN IN TO RENDER →</Link></p>
    </section>
  );
}
