"use client";

import Link from "next/link";
import { useProject } from "@/lib/projectContext";
import { AtomikMark } from "@/components/AtomikMark";

/**
 * The nav across the top of a production.
 *
 * The node surface is called NODES here, not Rig — one vocabulary, decided
 * once (SOW rule 5). The route is still /rig; a URL is not the word people
 * read, and moving it is a redirect that belongs with the larger question of
 * whether this is a tab at all or a mode the whole production sits in.
 *
 * It exists as a component because it was previously typed out by hand on
 * whichever production page happened to need it — and that is exactly how
 * the Rig went missing. Rig shipped with a graph, three layers, an element
 * screen and its own routes, and NOTHING linked to it: the only two links
 * in the codebase were on /shots/[id] and /elements/[id], both of which are
 * themselves unreachable. A whole surface, built and invisible.
 *
 * So the row is written once and every production page renders it. Adding a
 * surface now means adding a line here, not remembering five files.
 *
 * Cast and Cost deliberately point at /studio and /usage, which are not
 * production-scoped: that is how they already worked, and this change is
 * about finding the Rig, not re-planning the nav.
 */
export type ProductionTab = "production" | "shots" | "canvas" | "nodes";

export default function ProductionNav({ id, on }: { id: string; on: ProductionTab }) {
  /* Shots is the v2 grid (design/particl-v2 §7), which lives under the
     project's production; the overview here is the cap and the numbers. */
  const { projects } = useProject();
  const productionId = projects.find((p) => p.id === id)?.productionId ?? null;
  const tabs: [ProductionTab, string, string][] = [
    ["production", "Production", `/projects/${id}`],
    ["shots", "Shots", productionId ? `/productions/${productionId}/${id}/shots` : "/productions"],
    ["canvas", "Canvas", `/projects/${id}/canvas`],
    ["nodes", "Nodes", `/projects/${id}/rig`],
  ];
  return (
    <nav className="subnav" aria-label="Production">
      {tabs.map(([key, label, href]) =>
        key === on
          ? <span key={key} className="subnav-item is-on" aria-current="page">{label}</span>
          : <Link key={key} href={href} className="subnav-item">{label}</Link>
      )}
      <Link href="/studio" className="subnav-item">Cast</Link>
      <Link href="/usage" className="subnav-item">Cost</Link>
      <Link href="/atomik/shots" className="subnav-note hdr-mono-link flex items-center gap-2">
        <AtomikMark size={14} /> SHOT LIST · ATOMIK →
      </Link>
    </nav>
  );
}
