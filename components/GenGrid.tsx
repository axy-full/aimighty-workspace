"use client";

import GenCard, { type Gen } from "./GenCard";
import { usd } from "@/lib/format";

export default function GenGrid({
  gens, projects, onChanged, empty = "No clips.",
}: {
  gens: Gen[];
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
  empty?: string;
}) {
  if (!gens.length) {
    return (
      <div className="desk-grid grid h-full min-h-[200px] place-items-center rounded-[var(--r)] border border-line p-6">
        <p className="font-mono text-[10.5px] tracking-[.14em] text-mute">{empty}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(248px,1fr))]">
      {gens.map((g) => (
        <GenCard key={g.id} gen={g} projects={projects} onChanged={onChanged} />
      ))}
    </div>
  );
}

/**
 * The Library's body: videos and stills live in their own sections the
 * moment both exist. A single-kind library stays a flat grid — a lone
 * section header would just be noise.
 */
export function LibrarySections({
  gens, projects, onChanged, empty,
}: {
  gens: Gen[];
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
  empty?: string;
}) {
  const clips = gens.filter((g) => g.kind !== "image");
  const stills = gens.filter((g) => g.kind === "image");

  if (!clips.length || !stills.length) {
    return <GenGrid gens={gens} projects={projects} onChanged={onChanged} empty={empty} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Clips" items={clips} projects={projects} onChanged={onChanged} />
      <Section title="Stills" items={stills} projects={projects} onChanged={onChanged} />
    </div>
  );
}

function Section({ title, items, projects, onChanged }: {
  title: string; items: Gen[];
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
}) {
  const spend = items.reduce(
    (a, g) => a + (g.costUsd ?? 0) + (g.refineCostUsd ?? 0), 0
  );
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 className="ptitle text-[14.5px]">{title}</h2>
        <span className="font-mono text-[10.5px] tabular-nums text-mute">
          {String(items.length).padStart(2, "0")} · {usd(spend, 2)}
        </span>
        <span className="h-px min-w-0 flex-1 self-center bg-hair" />
      </div>
      <GenGrid gens={items} projects={projects} onChanged={onChanged} />
    </section>
  );
}
