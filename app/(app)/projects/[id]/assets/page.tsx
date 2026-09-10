"use client";

/**
 * Everything a project holds, in one place.
 *
 * Opening a project used to set the global selection and drop you at the
 * composer, which shows video and nothing else — so a project's stills, its
 * audio and its cast were only reachable by going somewhere else and
 * filtering. A project is the unit the studio thinks in, so this is the
 * page that answers "what have we got", in the order the work is made in:
 * video, then images, then audio, then the characters they were made with.
 *
 * Read-only on purpose. Every one of these things is created and edited
 * somewhere that already owns it — the composers, the Studio — and a second
 * set of add and delete controls over the same tables would be two truths
 * about one thing.
 */
import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo } from "@/lib/format";
import { Section } from "@/components/GenGrid";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import type { Gen } from "@/components/GenCard";
import type { CastMember } from "@/lib/cast";
import type { IdentityView } from "@/components/IdentitySheet";
import { useMoney } from "@/lib/price";

type Project = { id: string; name: string; description: string; code?: string; category?: string };

export default function ProjectAssets({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = `projectId=${encodeURIComponent(id)}`;

  /* One request per kind rather than one big one: the server already splits
     by kind, and asking separately means each section pages independently
     and an empty one costs nothing. The wall polls because renders land
     while you watch; the banks do not, because /api/identities asks fal
     about every training face on each call. */
  /* Three sections polling every eight seconds is three requests every eight
     seconds for a page that is mostly read, not watched. They poll briskly
     only while something is actually in flight; otherwise they tick slowly,
     and the change bus refreshes them at once when anything is deleted,
     renamed or moved. */
  const [live, setLive] = useState(false);
  const every = live ? 6000 : 30000;
  const { data: video, error: videoErr, refresh: rVideo } =
    useApi<{ generations: Gen[] }>(`/api/jobs?${q}&kind=video&limit=60`, every);
  const { data: images, refresh: rImages } =
    useApi<{ generations: Gen[] }>(`/api/jobs?${q}&kind=image&limit=60`, every);
  const { data: audio, refresh: rAudio } =
    useApi<{ generations: Gen[] }>(`/api/jobs?${q}&kind=audio&limit=60`, every);
  const { data: idData, refresh: rIds } =
    useApi<{ identities: IdentityView[] }>(`/api/identities?${q}`, 0);
  const { data: castData, refresh: rCast } =
    useApi<{ cast: CastMember[] }>(`/api/cast?${q}`, 0);
  const { data: projects } = useApi<{ projects: Project[] }>("/api/projects", 0);

  const refreshAll = () => { rVideo(); rImages(); rAudio(); rIds(); rCast(); };
  useOnChange(refreshAll);

  const project = projects?.projects.find((p) => p.id === id) ?? null;
  usePageTitle(project?.name ?? "Project");

  const clips = useMemo(() => video?.generations ?? [], [video]);
  const stills = useMemo(() => images?.generations ?? [], [images]);
  const sounds = useMemo(() => audio?.generations ?? [], [audio]);
  const identities = idData?.identities ?? [];
  const cast = castData?.cast ?? [];

  const anyLive = [...clips, ...stills, ...sounds]
    .some((g) => g.status === "queued" || g.status === "running");
  useEffect(() => {
    if (anyLive === live) return;
    Promise.resolve().then(() => setLive(anyLive));
  }, [anyLive, live]);

  const money = useMoney();
  const spend = money.sum([...clips, ...stills, ...sounds]);
  const total = clips.length + stills.length + sounds.length;

  if (!video) {
    return videoErr
      ? <Trouble label="This production didn't load" detail={videoErr} onRetry={refreshAll} />
      : <Waiting label="Reading the production" />;
  }

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px] pb-10">
        <Link href="/productions" className="mt-6 inline-block text-[14px] text-blue">← Productions</Link>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1 className="h1">{project?.name ?? "Project"}</h1>
          <span className="text-[15px] text-dim tabular-nums">
            {total} take{total === 1 ? "" : "s"} · {spend}
          </span>
          <span className="ml-auto flex flex-wrap gap-2">
            <Link href={`/projects/${id}`} className="chip">Overview</Link>
            <Link href={`/projects/${id}/canvas`} className="chip">Canvas</Link>
            <Link href="/studio" className="chip">Studio</Link>
          </span>
        </div>
        {project?.description && (
          <p className="mt-3 max-w-[70ch] text-[15px] text-dim">{project.description}</p>
        )}

        <div className="mt-8 flex flex-col gap-10">
          <Section title="Video" items={clips} onChanged={refreshAll}
            empty="No video in this production yet." />
          <Section title="Images" items={stills} onChanged={refreshAll}
            empty="No images in this production yet." />
          <Section title="Audio" items={sounds} onChanged={refreshAll}
            empty="No audio in this production yet." />

          {/* ── Characters ──────────────────────────────────────────────
              Two lists, not one merged one: the Studio shows identities and
              cast separately and a trained face legitimately appears in
              both, so merging here would make this page disagree with the
              place these are actually managed. */}
          <section>
            <div className="mb-3 flex items-baseline gap-2.5">
              <h2 className="text-[19px] font-semibold tracking-[-0.015em]">Characters</h2>
              <span className="text-[13.5px] tabular-nums text-mute">
                {identities.length + cast.length}
              </span>
              <Link href="/studio" className="ml-auto text-[13.5px] text-blue">Manage in Studio</Link>
            </div>

            {identities.length === 0 && cast.length === 0 ? (
              <div className="card">
                <Empty compact title="Nobody cast in this production yet"
                  line="Train a face or name a character in the Studio, then write @TheirName in any prompt." />
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {identities.length > 0 && (
                  <div>
                    <p className="grouplabel">Trained identities</p>
                    <div className="gal-grid mt-3">
                      {identities.map((i) => (
                        <Link key={i.id} href="/studio" className="gal-card card-link">
                          <span className="gal-cover bg-thumb">
                            {i.coverUploadId
                              ? /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={`/api/uploads/${i.coverUploadId}`} alt={i.name}
                                  className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                              : <span className="absolute inset-0 grid place-items-center font-mono text-[22px] text-mute">@</span>}
                            <span className={`gal-tag ${i.status === "ready" ? "!bg-ok !text-on-ink" : i.status === "training" ? "!bg-blue !text-on-ink" : ""}`}>
                              {i.status === "ready" ? "Ready" : i.status === "training" ? "Training" : i.status === "failed" ? "Failed" : "Draft"}
                            </span>
                          </span>
                          <span className="gal-body">
                            <span className="gal-name">@{i.name}</span>
                            <span className="gal-blurb">{i.description || "—"}</span>
                            <span className="gal-cat">
                              {i.status === "ready" && i.trainedAt ? `trained ${timeAgo(i.trainedAt)}` : i.status}
                            </span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {cast.length > 0 && (
                  <div>
                    <p className="grouplabel">Cast</p>
                    <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
                      {cast.map((m) => (
                        <div key={m.id} className="overflow-hidden rounded-[var(--r)] bg-panel2">
                          <div className="aspect-[4/3] w-full bg-thumb">
                            {m.uploadId && (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img src={`/api/uploads/${m.uploadId}`} alt={m.name}
                                className="h-full w-full object-cover" loading="lazy" />
                            )}
                          </div>
                          <div className="px-3 py-2">
                            <p className="flex items-baseline gap-2">
                              <span className="truncate font-mono text-[13px] font-medium text-ink">@{m.name}</span>
                              <span className="text-[11px] uppercase tracking-wide text-mute">
                                {m.kind === "style" ? "look" : m.kind}
                              </span>
                            </p>
                            <p className="mt-0.5 line-clamp-2 text-[12px] text-mute">{m.description || "—"}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
