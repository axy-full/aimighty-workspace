"use client";

import { useMemo, useState } from "react";
import { startGenDrag, readDraggedAsset, type DraggedAsset } from "@/lib/dnd";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { usd } from "@/lib/format";
import LazyMedia from "./LazyMedia";
import Boundary from "./Boundary";
import { IconChevron, IconPlus } from "./Icons";
import { appPrompt, appAlert } from "./dialog";
import type { CastMember } from "@/lib/cast";
import type { Gen } from "./GenCard";
import { useMoney } from "@/lib/price";

/**
 * The projects, always to hand.
 *
 * Everything the studio makes belongs to a project, but the projects lived
 * on their own screen — so using one meant leaving the room you were working
 * in. The rail keeps them beside the work: open one and its assets unroll
 * underneath, and any of them can be dragged straight into the prompt.
 *
 * Open assets are SPLIT BY MEDIA, in the order the full assets page uses —
 * video, images, audio, then the cast they were made with. They used to
 * arrive as one undifferentiated run of square thumbnails, which meant a
 * still, a clip and a failed job all looked alike at 68 pixels and the only
 * way to find the video you wanted was to hover every tile. Each kind now
 * gets its own labelled shelf and its own shape: clips are 16:9 because
 * that is what a clip is, stills are square, audio is a row with a name on
 * it because a waveform tells you nothing at this size, and cast are chips.
 *
 * It carries no state of its own. Selection is the same global selection the
 * composers already read, so opening a project here files the next render
 * there too, and the right-click menu comes for free: the rows carry the
 * same data attributes the Projects grid does, which is the whole contract
 * ContextMenu looks for.
 */

/* The drag payload lives in lib/dnd.ts now, shared by every card in the
   app; these re-exports keep the rail's old imports working. */
export { readDraggedAsset };
export type { DraggedAsset };

export default function ProjectRail() {
  const path = usePathname();
  const router = useRouter();
  const { projects, selection, setSelection, refreshProjects } = useProject();
  const { signedIn } = useSession();
  const money = useMoney();
  const [open, setOpen] = useState<string | null>(null);

  useOnChange(refreshProjects);

  // Only the open project's assets are fetched, and only once — a rail that
  // polled every project would cost more than the wall it sits beside. One
  // request for all three media kinds, split in the browser: the shelves are
  // a way of READING forty rows, not a reason to ask for them three times.
  const { data, refresh } = useApi<{ generations: Gen[] }>(
    open ? `/api/jobs?projectId=${encodeURIComponent(open)}&limit=40&sync=0` : null, 0
  );
  const { data: castData, refresh: refreshCast } = useApi<{ cast: CastMember[] }>(
    open ? `/api/cast?projectId=${encodeURIComponent(open)}` : null, 0
  );
  useOnChange(() => { refresh(); refreshCast(); });

  const assets = useMemo(() => data?.generations ?? [], [data]);
  const cast = castData?.cast ?? [];

  /* One pass, three buckets. A render with no kind recorded is a clip:
     video is what this app made before it made anything else, and those
     rows predate the column.

     Within a shelf the finished renders come first and the failures and
     the still-running settle at the end. Nothing is hidden — the shelf
     count is every row — but a dead tile carries no thumbnail and cannot
     be dragged, so leaving them scattered through the sheet in strict
     recency order punched holes in the one thing the sheet is for. */
  const shelves = useMemo(() => {
    const video: Gen[] = [], image: Gen[] = [], audio: Gen[] = [];
    for (const g of assets) {
      if (g.kind === "image") image.push(g);
      else if (g.kind === "audio") audio.push(g);
      else video.push(g);
    }
    const settled = (list: Gen[]) => {
      const done = list.filter((g) => g.status === "succeeded");
      const rest = list.filter((g) => g.status !== "succeeded");
      return [...done, ...rest];
    };
    return { video: settled(video), image: settled(image), audio: settled(audio) };
  }, [assets]);

  /* Ambient, so it is asked for slowly. */
  const { data: spend } = useApi<{ spentUsd: number; remainingUsd: number }>(
    "/api/usage/summary", 60_000
  );

  const loaded = Boolean(data);
  const empty = loaded && assets.length === 0 && cast.length === 0;

  async function create() {
    const name = await appPrompt("New production", "", "Production name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Couldn't create the production", json.error); return; }
    refreshProjects();
    setSelection(json.id);
    setOpen(json.id);
  }

  function choose(id: string) {
    setSelection(id);
    setOpen((cur) => (cur === id ? null : id));
  }

  return (
    <aside className="rail" aria-label="Projects">
      <div className="rail-head">
        <span className="grouplabel !pb-0">Productions</span>
        <button type="button" onClick={create} className="rail-new" title="New production"
          aria-label="New production">
          <IconPlus className="!h-3.5 !w-3.5" />
        </button>
      </div>

      <div className="rail-body">
        {projects.length === 0 && (
          <p className="px-3 py-2 text-[12.5px] leading-relaxed text-mute">
            {signedIn
              ? "No productions yet. Everything you make lands in Unfiled until there is one."
              : "Productions are private. Sign in and yours appear here."}
          </p>
        )}

        {projects.map((p) => {
          const isOpen = open === p.id;
          return (
            /* `is-open` puts a ground and a border under the whole group. An
               open project used to end wherever its last thumbnail happened
               to fall, so the next project's name read as part of it. */
            <div key={p.id} className={`rail-group ${isOpen ? "is-open" : ""}`}>
              {/* The row and its assets are SIBLINGS, not parent and child:
                  the right-click menu looks up a clip before a project, so a
                  tile nested inside the row would give a clip menu on the
                  row's own padding. */}
              <button type="button" onClick={() => choose(p.id)}
                data-project-target={p.id} data-project-name={p.name} data-project-count={p.genCount}
                className={`rail-row ${selection === p.id ? "is-on" : ""}`}
                aria-expanded={isOpen}
                title={`${p.genCount} render${p.genCount === 1 ? "" : "s"} · ${money.of(p)}`}>
                <IconChevron className={`rail-caret ${isOpen ? "is-open" : ""}`} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="rail-count">{p.genCount}</span>
              </button>

              {isOpen && (
                <Boundary what="This production's assets" compact resetKey={p.id}>
                  <div className="rail-shelves">
                    {!loaded && <p className="rail-note">Reading the production…</p>}
                    {empty && <p className="rail-note">Nothing in here yet.</p>}

                    <Shelf title="Video" n={shelves.video.length}>
                      <div className="rail-grid is-wide">
                        {shelves.video.map((g) => <Tile key={g.id} g={g} wide />)}
                      </div>
                    </Shelf>

                    <Shelf title="Images" n={shelves.image.length}>
                      <div className="rail-grid">
                        {shelves.image.map((g) => <Tile key={g.id} g={g} />)}
                      </div>
                    </Shelf>

                    <Shelf title="Audio" n={shelves.audio.length}>
                      <div className="flex flex-col gap-1">
                        {shelves.audio.map((g) => <AudioRow key={g.id} g={g} />)}
                      </div>
                    </Shelf>

                    <Shelf title="Cast" n={cast.length}>
                      <div className="flex flex-wrap gap-1">
                        {cast.map((c) => (
                          <span key={c.id} className="rail-cast" title={c.description || c.kind}>
                            @{c.name}
                          </span>
                        ))}
                      </div>
                    </Shelf>

                    <button type="button" onClick={() => router.push(`/projects/${p.id}/assets`)}
                      className="rail-all">
                      Open all {p.name.length > 18 ? "assets" : `of ${p.name}`}
                    </button>
                  </div>
                </Boundary>
              )}
            </div>
          );
        })}
      </div>

      {/* The running spend, rehoused.
          It used to sit in the far corner of the top bar, which is the
          loudest position on the screen and the wrong one for a number that
          only ever goes up and that nothing on that bar can act on. Here it
          is still on every screen, still glanceable, and directly beside the
          page that explains it. Its own poll is slow on purpose: this is
          ambient, not live, and the top bar already asks every 20 seconds
          for the thing that IS live. */}
      <div className="rail-foot">
        <Link href="/projects" className={`rail-link ${path === "/projects" ? "text-ink" : ""}`}>All productions</Link>
        {open && (
          <button type="button" onClick={() => router.push(`/projects/${open}/assets`)} className="rail-link">
            Open
          </button>
        )}
        {spend != null && !money.inCredits && (
          <Link href="/usage" className="rail-spend"
            title={spend.remainingUsd >= 0
              ? `${usd(spend.remainingUsd, 2)} of recorded credit left`
              : "Spend has passed the credit recorded on the Usage page"}>
            {usd(spend.spentUsd, 2)} used
          </Link>
        )}
      </div>
    </aside>
  );
}

/**
 * One media shelf, or nothing at all.
 *
 * An empty shelf is not drawn. Four headings with three "none yet" lines
 * under them would push the one shelf that HAS something below the fold, in
 * a column this narrow — the point of the split is to find things faster,
 * not to inventory what the project lacks. The full assets page keeps its
 * empty sections, because it has the room to be an inventory.
 */
function Shelf({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  if (n === 0) return null;
  return (
    <section className="rail-shelf">
      <p className="rail-shelf-head">
        <span>{title}</span>
        <span className="rail-shelf-n">{n}</span>
      </p>
      {children}
    </section>
  );
}

/** A clip or a still. `wide` gives it a clip's shape. */
function Tile({ g, wide = false }: { g: Gen; wide?: boolean }) {
  const url = g.storedUrl ?? g.sourceUrl;
  const ready = g.status === "succeeded" && Boolean(url);
  // Only a finished, visual render can be dropped into a prompt — the same
  // two gates the server applies, so a doomed drop is impossible rather
  // than merely refused.
  const canDrag = ready && g.kind !== "audio";
  return (
    <span
      draggable={canDrag}
      onDragStart={(e) => setDrag(e, g)}
      data-gen-id={g.id} data-gen-prompt={g.prompt}
      data-gen-label={g.title || g.id.slice(-6).toUpperCase()}
      data-gen-title={g.title ?? ""}
      title={g.title || g.prompt}
      className={`rail-asset ${wide ? "is-wide" : ""} ${canDrag ? "is-draggable" : ""} ${ready ? "" : "is-dead"}`}>
      {ready ? (
        <LazyMedia url={url!} kind={g.kind === "image" ? "image" : "video"}
          alt="" className="!absolute inset-0" />
      ) : (
        <span className="rail-dead">{g.status === "failed" ? "failed" : "…"}</span>
      )}
    </span>
  );
}

/**
 * A piece of audio.
 *
 * A row rather than a tile: at 68 pixels a waveform is a smudge and a
 * black square says nothing, so the name is the only part worth showing.
 */
function AudioRow({ g }: { g: Gen }) {
  const ready = g.status === "succeeded" && Boolean(g.storedUrl ?? g.sourceUrl);
  return (
    <span
      draggable={false}
      data-gen-id={g.id} data-gen-prompt={g.prompt}
      data-gen-label={g.title || g.id.slice(-6).toUpperCase()}
      data-gen-title={g.title ?? ""}
      title={g.title || g.prompt}
      className={`rail-audio ${ready ? "" : "is-dead"}`}>
      <span aria-hidden className="rail-audio-mark" />
      <span className="min-w-0 flex-1 truncate">
        {g.title || g.prompt || g.id.slice(-6).toUpperCase()}
      </span>
    </span>
  );
}

const setDrag = startGenDrag;

