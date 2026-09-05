"use client";

/**
 * Library — every render, from the pipeline handoff.
 *
 * Two kinds of thing live here. UNFILED renders — made in All projects, or
 * never filed against a shot — come first, on dashed cards: they have no
 * version number and no name until they are filed, and the card's one
 * action is to file them. Then the DAY GROUPS: everything else, newest
 * first, as the same take cards the walls use, each wearing its
 * production's name.
 *
 * Searching and filtering are the SERVER's job. The browser only ever
 * holds the pages it has asked for, so filtering in the browser would
 * quietly search the newest slice and report that everything older doesn't
 * exist.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Take, clipId } from "@/components/Feed";
import Theatre from "@/components/Theatre";
import type { Gen } from "@/components/GenCard";
import { Empty, Waiting } from "@/components/ParticlMark";
import { appAlert } from "@/components/dialog";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { useSession } from "@/lib/session";
import { usd, timeAgo } from "@/lib/format";
import { useProject } from "@/lib/projectContext";
import { usePageTitle } from "@/lib/usePageTitle";
import type { Shot } from "@/lib/shots";

const PAGE = 60;
type Page = { generations: Gen[]; nextCursor: number | null };

const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(t: number): string {
  const d = new Date(t); const now = new Date();
  const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (dayKey(t) === dayKey(now.getTime())) return `Today · ${md}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(t) === dayKey(y.getTime())) return `Yesterday · ${md}`;
  return md;
}
const specOf = (g: Gen) => {
  const p = g.params as { duration?: number; resolution?: string; lengthMs?: number; durationSeconds?: number };
  if (g.kind === "audio") { const s = p.durationSeconds ?? (p.lengthMs ? p.lengthMs / 1000 : null); return s ? `0:${String(Math.round(s)).padStart(2, "0")}` : "audio"; }
  if (g.kind === "image") return String(p.resolution ?? "").toUpperCase();
  return `${p.duration ?? ""}s · ${String(p.resolution ?? "").toUpperCase()}`;
};

export default function LibraryPage() {
  usePageTitle("Library");
  const router = useRouter();
  const { signedIn } = useSession();
  const { projects } = useProject();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");        // debounced, what the server sees
  const [project, setProject] = useState("any"); // any | unfiled | id
  const [kind, setKind] = useState("any");
  const [status, setStatus] = useState("any");
  const [mine, setMine] = useState(false);

  const [older, setOlder] = useState<Gen[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const scope =
    (project === "any" || project === "unfiled" ? "" : `&projectId=${encodeURIComponent(project)}`) +
    (kind !== "any" ? `&kind=${kind}` : "") +
    (mine ? "&mine=1" : "") +
    (status !== "any" ? `&status=${status}` : "") +
    (query ? `&q=${encodeURIComponent(query)}` : "");

  const { data, refresh } = useApi<Page>(signedIn ? `/api/jobs?limit=${PAGE}${scope}` : null, 8000);
  useOnChange(refresh);

  // Any change of scope invalidates the older pages — they belong to the
  // question that was being asked before.
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    setOlder([]); setCursor(null); setExhausted(false);
  }, [scope]);

  const first = useMemo(() => data?.generations ?? [], [data]);
  const gens = useMemo(() => {
    const seen = new Set<string>();
    const out: Gen[] = [];
    for (const g of [...first, ...older]) {
      if (seen.has(g.id)) continue;
      seen.add(g.id); out.push(g);
    }
    const shown = project === "unfiled" ? out.filter((g) => !g.projectId) : out;
    return shown.sort((a, b) => b.createdAt - a.createdAt);
  }, [first, older, project]);

  const nextCursor = cursor ?? data?.nextCursor ?? null;
  const canLoadMore = !exhausted && nextCursor != null;
  async function loadMore() {
    if (!canLoadMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/jobs?limit=${PAGE}&sync=0&before=${nextCursor}${scope}`, { cache: "no-store" });
      const page: Page = await res.json();
      if (!res.ok) throw new Error("Could not load more");
      setOlder((prev) => [...prev, ...(page.generations ?? [])]);
      setCursor(page.nextCursor);
      if (!page.nextCursor || !page.generations?.length) setExhausted(true);
    } catch {
      /* Deliberately NOT setExhausted: one failed page used to retire the
         button for good. Leave it pressable so they can simply try again. */
    } finally { setLoadingMore(false); }
  }

  const unfiled = gens.filter((g) => !g.shotCode);
  const days = useMemo(() => {
    const map = new Map<string, Gen[]>();
    for (const g of gens) { if (!g.shotCode) continue; const k = dayKey(g.createdAt); (map.get(k) ?? map.set(k, []).get(k)!).push(g); }
    return [...map.values()].map((list) => ({
      key: dayKey(list[0].createdAt), label: dayLabel(list[0].createdAt), items: list,
      meta: `${list.length} render${list.length === 1 ? "" : "s"} · ${usd(list.reduce((a, g) => a + (g.costUsd ?? 0) + (g.refineCostUsd ?? 0), 0), 2)} · ${[...new Set(list.map((g) => g.projectName).filter(Boolean))].join(", ") || "no production"}`,
    }));
  }, [gens]);

  // The theatre walks the visual renders; audio opens its own desk.
  const [active, setActive] = useState<string | null>(null);
  const visual = useMemo(() => gens.filter((g) => g.kind !== "audio"), [gens]);
  function open(g: Gen) {
    if (g.kind === "audio") { router.push("/audio"); return; }
    setActive(g.id);
  }
  // One clock for the cards, taken once per mount — rendering is pure.
  const [now] = useState(() => Date.now());

  return (
    <>
      <nav className="subnav !h-[52px] !px-6 !gap-3.5" aria-label="Library">
        <Link href="/projects" className="subnav-item">All projects</Link>
        <span className="subnav-item is-on" aria-current="page">Library</span>
        <span className="h-4 w-px bg-line" />
        <div className="flex gap-1.5">
          <label className="chip-dd !py-1.5 !px-2.5">Project
            <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className="!text-dim">
              <option value="any">any</option><option value="unfiled">unfiled</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select><span className="hdr-caret" aria-hidden="true">▼</span>
          </label>
          <label className="chip-dd !py-1.5 !px-2.5">Type
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type" className="!text-dim">
              <option value="any">video · stills · audio</option><option value="video">video</option><option value="image">stills</option><option value="audio">audio</option>
            </select><span className="hdr-caret" aria-hidden="true">▼</span>
          </label>
          <label className="chip-dd !py-1.5 !px-2.5">State
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="State" className="!text-dim">
              <option value="any">any</option><option value="succeeded">finished</option><option value="running">rendering</option><option value="queued">queued</option><option value="failed">failed</option>
            </select><span className="hdr-caret" aria-hidden="true">▼</span>
          </label>
          <label className="chip-dd !py-1.5 !px-2.5">Person
            <select value={mine ? "me" : "anyone"} onChange={(e) => setMine(e.target.value === "me")} aria-label="Person" className="!text-dim">
              <option value="anyone">anyone</option><option value="me">me</option>
            </select><span className="hdr-caret" aria-hidden="true">▼</span>
          </label>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="search w-[240px]">
            <span className="search-glyph" aria-hidden>⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every render, @cast, prompt text…" />
          </label>
          <span className="mono-s">NEWEST FIRST</span>
        </div>
      </nav>

      <div className="page !p-[22px_24px_48px] flex flex-col gap-7">
        {!signedIn ? (
          <Empty title="The library is private" line="Every render the studio has made lives here, newest first, filed under its production and shot. Sign in to see it." />
        ) : !data ? (
          <Waiting label="Opening the library" />
        ) : gens.length === 0 ? (
          <Empty title={query ? `Nothing matching “${query}”` : "Nothing here yet"} line={query ? "Try fewer words, or a shot code." : "Renders land here the moment they are made."} />
        ) : (
          <>
            {unfiled.length > 0 && (
              <section className="flex flex-col gap-2.5">
                <div className="grp-head">
                  <span className="grp-title">Unfiled</span>
                  <span className="grp-meta">{unfiled.length} render{unfiled.length === 1 ? "" : "s"} not filed against a shot — they have no version number and no name until they are.</span>
                </div>
                <div className="grp-grid is-lib is-unfiled">
                  {unfiled.map((g) => <UnfiledCard key={g.id} gen={g} onOpen={() => open(g)} onChanged={refresh} />)}
                </div>
              </section>
            )}
            {days.map((d) => (
              <section key={d.key} className="flex flex-col gap-2.5">
                <div className="grp-head">
                  <span className="grp-title">{d.label}</span>
                  <span className="grp-meta">{d.meta}</span>
                  <span className="grp-rule" />
                </div>
                <div className="grp-grid is-lib">
                  {d.items.map((g) => (
                    <Take key={g.id} gen={g} code={g.shotCode ?? ""} active={g.id === active} now={now}
                      onOpen={() => open(g)} onChanged={refresh} badge={g.projectName ?? "no production"} />
                  ))}
                </div>
              </section>
            ))}
            {canLoadMore && (
              <div className="flex justify-center">
                <button type="button" onClick={loadMore} disabled={loadingMore} className="btn-secondary">
                  {loadingMore ? "Loading…" : "Load older renders"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <Theatre gens={visual} activeId={active} onClose={() => setActive(null)} onSelect={setActive} onChanged={refresh} />
    </>
  );
}

/**
 * A render with no shot: dashed, nameless, its one action to file it. Filing
 * needs a production; a render outside every production is moved into one
 * first (right-click → Move to project…).
 */
function UnfiledCard({ gen, onOpen, onChanged }: { gen: Gen; onOpen: () => void; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { data } = useApi<{ shots: Shot[] }>(menu && gen.projectId ? `/api/shots?projectId=${encodeURIComponent(gen.projectId)}` : null, 0);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);
  async function file(shotId: string) {
    setMenu(false);
    const res = await fetch(`/api/jobs/${gen.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shotId }) });
    if (!res.ok) { await appAlert("The render wasn't filed", `The server answered ${res.status}.`); return; }
    onChanged();
  }
  const kindWord = gen.kind === "image" ? "still" : gen.kind === "audio" ? "audio" : "video";
  return (
    <div className="take is-unfiled" data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)} data-gen-title={gen.title ?? ""}>
      <button type="button" className="take-hit" onClick={onOpen} title={gen.prompt}>
        <span className="well take-well">
          <span className="well-cap">{kindWord} · unfiled</span>
          <span className="well-badge br">{specOf(gen)}</span>
        </span>
      </button>
      <div className="take-body">
        <span className="lib-prompt">{gen.prompt}</span>
        <div className="flex items-center justify-between gap-2">
          <span className="take-meta"><span>{gen.authorName ? `${gen.authorName} · ` : ""}{timeAgo(gen.createdAt)}</span></span>
          <div ref={wrap} className="relative">
            <button type="button" className="trk-btn" onClick={() => {
              if (!gen.projectId) { appAlert("Move it into a production first", "Right-click the render → Move to project…, then file it against one of that production's shots."); return; }
              setMenu((v) => !v);
            }}>File against a shot</button>
            {menu && (
              <div role="menu" className="menu-pop absolute right-0 top-full z-30 mt-1 min-w-[220px]">
                {(data?.shots ?? []).map((s) => (
                  <button key={s.id} type="button" role="menuitem" className="menu-item" onClick={() => file(s.id)}>
                    <span className="mono-s mr-2">{s.code}</span><span className="min-w-0 flex-1 truncate">{s.title || "Untitled shot"}</span>
                  </button>
                ))}
                {data && data.shots.length === 0 && <span className="menu-item text-mute">No shots in that production yet.</span>}
                {!data && <span className="menu-item text-mute">Reading the shots…</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
