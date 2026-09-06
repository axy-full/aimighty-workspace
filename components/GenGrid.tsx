"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import GenCard, { type Gen } from "./GenCard";
import Theatre from "./Theatre";
import Boundary from "./Boundary";
import { Empty } from "./ParticlMark";
import { usd } from "@/lib/format";
import { useProject } from "@/lib/projectContext";

export default function GenGrid({
  gens, projects, onChanged, empty = "No clips.",
}: {
  gens: Gen[];
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
  empty?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const router = useRouter();
  const { setSelection } = useProject();

  /** "Use" from the library: carry the prompt to the composer, in its project. */
  function useGen(g: Gen) {
    const typed = (g.params as { rawPrompt?: string }).rawPrompt || g.prompt;
    try { window.localStorage.setItem("aw_compose_seed", typed); } catch { /* private mode */ }
    if (g.projectId) setSelection(g.projectId);
    router.push("/");
  }

  if (!gens.length) {
    return (
      <div className="grid h-full min-h-[200px] place-items-center rounded-[var(--r)] bg-panel2 p-6">
        <Empty compact title={empty} />
      </div>
    );
  }
  return (
    <>
      <div className="grid gap-x-5 gap-y-7 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
        {gens.map((g) => (
          <GenCard key={g.id} gen={g} projects={projects} onChanged={onChanged} onOpen={() => setOpen(g.id)} />
        ))}
      </div>
      <Boundary what="This take">
        <Theatre
          gens={gens} activeId={open && gens.some((g) => g.id === open) ? open : null}
          onClose={() => setOpen(null)} onSelect={setOpen}
          onChanged={() => onChanged?.()} onUse={useGen}
        />
      </Boundary>
    </>
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
  const clips = gens.filter((g) => g.kind !== "image" && g.kind !== "audio");
  const stills = gens.filter((g) => g.kind === "image");
  const sounds = gens.filter((g) => g.kind === "audio");

  if ([clips, stills, sounds].filter((l) => l.length).length < 2) {
    return <GenGrid gens={gens} projects={projects} onChanged={onChanged} empty={empty} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {clips.length > 0 && <Section title="Clips" items={clips} projects={projects} onChanged={onChanged} />}
      {stills.length > 0 && <Section title="Stills" items={stills} projects={projects} onChanged={onChanged} />}
      {sounds.length > 0 && <Section title="Audio" items={sounds} projects={projects} onChanged={onChanged} />}
    </div>
  );
}

/**
 * One kind of render under its own heading, with its count and what it cost.
 * Exported because the project's asset view wants exactly this and a second
 * splitter would be the third in the codebase — Feed's filter chips and
 * LibrarySections are already two.
 */
export function Section({ title, items, projects, onChanged, empty }: {
  title: string; items: Gen[];
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
  /** What to say when this kind has nothing. Without it GenGrid says
   *  "No clips.", which is wrong under an Images or Audio heading. */
  empty?: string;
}) {
  const spend = items.reduce(
    (a, g) => a + (g.costUsd ?? 0) + (g.refineCostUsd ?? 0), 0
  );
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 className="text-[19px] font-semibold tracking-[-0.015em]">{title}</h2>
        <span className="text-[13.5px] tabular-nums text-mute">
          {items.length} · {usd(spend, 2)}
        </span>
      </div>
      <GenGrid gens={items} projects={projects} onChanged={onChanged} empty={empty} />
    </section>
  );
}
