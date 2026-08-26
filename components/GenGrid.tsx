"use client";

import GenCard, { type Gen } from "./GenCard";

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
      <div className="desk-grid grid h-full min-h-[200px] place-items-center p-6">
        <p className="font-mono text-[10.5px] tracking-[.14em] text-mute">{empty}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-2.5 p-2.5 [grid-template-columns:repeat(auto-fill,minmax(268px,1fr))]">
      {gens.map((g) => (
        <GenCard key={g.id} gen={g} projects={projects} onChanged={onChanged} />
      ))}
    </div>
  );
}
