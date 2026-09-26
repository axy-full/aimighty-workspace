"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { estimateVideo, estimateImage } from "@/lib/rateTable";
import { estimateTokens, costUsd } from "@/lib/models";
import type { Board, BoardNode, BoardWire, NodeKind } from "@/lib/boards";
import { markStale } from "@/lib/boardGraph";
import type { ProductionRow } from "@/lib/productions";
import type { Shot } from "@/lib/shots";
import type { ElementFull } from "@/lib/elements";
import type { Engine } from "@/lib/atomik";
import type { Generation } from "@/lib/jobs";
import { Button, Mono, Chip } from "@/components/ui";
import { ToastHost, useToast } from "@/components/ui/Toast";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import Loader, { PageLoader, LOADER_SIZES } from "@/components/atomik/Loader";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import LazyMedia from "@/components/LazyMedia";
import { RigBar, RigStrip, rigHrefs, Avatar } from "@/components/rig/RigBar";
import PhoneBoard from "@/components/rig/PhoneBoard";
import { usePhone } from "@/lib/usePhone";
import { useAtomikRail } from "@/lib/atomikRail";
import NewAssetSheet from "@/components/assets/NewAssetSheet";
import {
  KIND_TAG, KIND_WORD, ADDABLE_KINDS, NODE_W, TAKES_DOT_LEFT, isGen, isRunnable,
  outputDotTop, outputPoint, portPoint, wirePath, wireMid, endpoints, newNode, nid,
} from "@/components/rig/nodes";
import { createBoardSaver, type BoardSaver, type SaveState } from "@/lib/boardSaver";
import { boardUrlFor } from "@/lib/rigCanvasUrl";

/**
 * Rig · Canvas (design/particl-v2/README.md §8; board 6a), value for value.
 *
 * The sub-bar: `Canvas · Recipes · Run`, the board chip (`Handbag TVC · SH04
 * board ▼`), `9 NODES · 2 RUN · 27 CR SPENT · BUILDING IS FREE`, the
 * collaborators, `Share`, `Save as recipe`. Then the 56px strip, the board
 * — dotted (`radial-gradient(rgba(245,246,248,.07) 1px, transparent 1px)`
 * on 24px) with the `+ Add node ⌘K` pill top-left and the node kinds
 * beside it, the bottom toolbar (`Select · Hand · Wire · Note · 100% ·
 * Fit · RUN UNRUN · N CR`) — and the 300px inspector.
 *
 * Nodes are §8's, at the board's numbers (`components/rig/nodes.ts`).
 * Wires are cubic beziers from an output dot to a slot dot: .3 at 1.5px
 * inherited, ink 2.5px for an override, dashed .35 for filed / created,
 * ink 2px when selected. A wire lands on a slot, not a node (§16: ±2px —
 * the dot is the drop target and the wire ends on its centre).
 *
 * Rules (§8): building is free; a node prices itself before it runs — from
 * the engine's rate table, never typed; anything upstream changing marks
 * downstream nodes stale, never re-runs them; an output files to a shot as
 * its next version through the ordinary generate route; `Save as recipe`
 * turns the board's generate nodes into stages.
 *
 * Below 768 (design/particl-v2-mobile, board M5) the Rig is read-and-run:
 * the board built on a desktop is shown as one stack down one wire
 * (`components/rig/PhoneBoard.tsx`), a slot opens its inspector sheet, and
 * `Run node again · 19 CR` is pinned under `BUILT ON DESKTOP · RUN AND
 * FILE FROM HERE`. No adding, no dragging, no wiring on a phone.
 */
type Tool = "select" | "hand" | "wire" | "note";
type Loaded = { board: Board };
type ShotRow = Shot & { takes: number; spend: number; credits?: number; state?: string; poster?: string | null };
type Wiring = { from: { nodeId: string; portId: string }; x: number; y: number };

export default function CanvasPage() {
  return <ToastHost><Canvas /></ToastHost>;
}

function Canvas() {
  const { boardId } = useParams<{ boardId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { signedIn, rates, models, name: myName } = useSession();
  const money = useMoney();
  const toast = useToast();
  const { engines, engineLabel } = useAtomik();
  const phone = usePhone();
  const rail = useAtomikRail();
  const [slotSel, setSlotSel] = useState<{ nodeId: string; slotId: string } | null>(null);

  /* `new?project=` opens the project's board — the latest one, or a fresh one when it has none — and lands on it,
     carrying every other param (`shot`, `ref`). A failure is said, with a retry, instead of spinning for ever. */
  const wantsNew = boardId === "new";
  const projectFromUrl = search.get("project");
  const shotFromUrl = search.get("shot");
  const query = search.toString();
  const [openError, setOpenError] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  useEffect(() => {
    if (!wantsNew || !projectFromUrl || !signedIn) return;
    let live = true;
    const said = async (r: Response) => ((await r.json().catch(() => ({}))).error as string | undefined) ?? `The server answered ${r.status}.`;
    (async () => {
      try {
        const listed = await fetch(`/api/rig/boards?projectId=${encodeURIComponent(projectFromUrl)}`);
        if (!listed.ok) throw new Error(await said(listed));
        const list = await listed.json().catch(() => ({}));
        const boards: Board[] = Array.isArray(list.boards) ? list.boards : [];
        if (!live) return;
        if (boards.length) { router.replace(boardUrlFor(boards[boards.length - 1].id, query)); return; }
        const created = await fetch("/api/rig/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: projectFromUrl, name: "Board" }) });
        if (!created.ok) throw new Error(await said(created));
        const made = await created.json().catch(() => ({}));
        if (!made.board?.id) throw new Error("The board was not made.");
        if (live) router.replace(boardUrlFor(made.board.id, query));
      } catch (e) {
        if (live) setOpenError((e as Error).message || "The board could not be opened.");
      }
    })();
    return () => { live = false; };
  }, [wantsNew, projectFromUrl, query, signedIn, router, openAttempt]);

  const { data: loaded, status: loadStatus, error: loadError, refresh: reloadBoard } = useApi<Loaded>(signedIn && !wantsNew ? `/api/rig/boards/${encodeURIComponent(boardId)}` : null, 0);
  const projectId = loaded?.board.projectId ?? null;
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  const { data: shotsData } = useApi<{ shots: ShotRow[] }>(projectId ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 30_000);
  const { data: elements, refresh: refreshElements } = useApi<{ elements: ElementFull[] }>(projectId ? `/api/rig/elements?projectId=${encodeURIComponent(projectId)}` : null, 30_000);
  const [assetSheet, setAssetSheet] = useState(false);
  const production = prods?.productions.find((p) => p.projects.some((j) => j.id === projectId)) ?? null;
  usePageTitle(loaded ? `${loaded.board.name} · Canvas` : "Canvas");

  const [board, setBoard] = useState<Board | null>(null);
  const shownBoard = board && loaded && board.id === loaded.board.id ? board : loaded?.board ?? null;
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [wiring, setWiring] = useState<Wiring | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const surface = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Board | null>(null);
  useEffect(() => { latest.current = shownBoard; }, [shownBoard]);

  /* The board is the unit of edit: every change writes the whole graph, a beat later — through a saver that
     keeps the graph until the server has it and sends the revision it was edited from (lib/boardSaver.ts). */
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved" });
  const saver = useRef<{ id: string; saver: BoardSaver } | null>(null);
  const commit = useCallback((next: Board) => {
    setBoard(next);
    latest.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (saver.current?.id !== next.id) {
        saver.current = {
          id: next.id,
          saver: createBoardSaver({
            baseUpdatedAt: next.updatedAt,
            onState: setSaveState,
            put: (body) => fetch(`/api/rig/boards/${encodeURIComponent(next.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body }),
          }),
        };
      }
      saver.current.saver.save({ nodes: next.nodes, wires: next.wires });
    }, 400);
  }, []);
  /* An unsaved graph is not left behind without a word. */
  useEffect(() => {
    if (saveState.kind !== "failed") return;
    const hold = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [saveState.kind]);
  const patchNode = useCallback((id: string, patch: Partial<BoardNode>, stale = false) => {
    const b = latest.current;
    if (!b) return;
    let next: Board = { ...b, nodes: b.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
    if (stale) next = { ...next, nodes: markStale(next, id) };
    commit(next);
  }, [commit]);

  /* ── prices (§8: a node prices itself before it runs, from the engine's table) ── */
  const engineOf = useCallback((n: BoardNode): string => String(n.ref?.engine ?? (n.kind === "image" ? models?.image : models?.video) ?? ""), [models]);
  const priceOf = useCallback((n: BoardNode): number => {
    if (n.kind === "image") {
      const est = estimateImage(rates, engineOf(n), String(n.settings.resolution ?? "1K"), Number(n.settings.refs ?? 0));
      return (est ?? 0) * Number(n.settings.count ?? 1);
    }
    if (n.kind === "video") {
      const secs = Number(n.settings.seconds ?? 5); const res = String(n.settings.resolution ?? "1080p");
      const est = estimateVideo(rates, engineOf(n), res, secs, estimateTokens(res, String(n.settings.ratio ?? "16:9"), secs), costUsd, { audio: Boolean(n.settings.audio) });
      return est ?? 0;
    }
    return n.credits;
  }, [rates, engineOf]);
  const fmt = useCallback((n: number) => money.price(n), [money]);

  /* ── the surface ──────────────────────────────────────────────────── */
  const toBoardXY = useCallback((e: { clientX: number; clientY: number }) => {
    const r = surface.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom };
  }, [pan, zoom]);

  const addNode = useCallback((kind: NodeKind, x?: number, y?: number, extra: Partial<BoardNode> = {}): BoardNode | null => {
    const b = latest.current;
    if (!b) return null;
    const px = x ?? (-pan.x + 120 + b.nodes.length * 24) / zoom, py = y ?? (-pan.y + 120 + b.nodes.length * 24) / zoom;
    const engine = isGen(kind) ? engineOf({ kind, ref: null } as BoardNode) : "";
    const node = newNode(kind, Math.round(px), Math.round(py), { ...(isGen(kind) && engine ? { ref: { engine }, label: engineLabel(engine) } : {}), ...extra });
    commit({ ...b, nodes: [...b.nodes, node] });
    setSelected(node.id); setAddMenu(null);
    return node;
  }, [pan, zoom, commit, engineOf, engineLabel]);

  const onSurfaceDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    if (tool === "note") { const p = toBoardXY(e); addNode("note", p.x, p.y); setTool("select"); return; }
    setSelected(null); setSelectedWire(null); setAddMenu(null);
    if (tool === "hand" || e.altKey) {
      const start = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      const move = (ev: PointerEvent) => setPan({ x: ev.clientX - start.x, y: ev.clientY - start.y });
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    }
  };
  const onNodeDown = (n: BoardNode) => (e: RPointerEvent) => {
    if (e.button !== 0 || tool === "hand") return;
    e.stopPropagation();
    setSelected(n.id); setSelectedWire(null); setAddMenu(null);
    if (tool === "wire" && n.kind !== "note") { const p = toBoardXY(e); setWiring({ from: { nodeId: n.id, portId: "out" }, x: p.x, y: p.y }); return; }
    const p = toBoardXY(e);
    setDrag({ id: n.id, dx: p.x - n.x, dy: p.y - n.y });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (ev: PointerEvent) => {
      const p = toBoardXY(ev);
      setBoard((b) => b && { ...b, nodes: b.nodes.map((n) => (n.id === drag.id ? { ...n, x: Math.round(p.x - drag.dx), y: Math.round(p.y - drag.dy) } : n)) });
    };
    const up = () => { setDrag(null); if (latest.current) commit(latest.current); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag, toBoardXY, commit]);

  /* Wiring: from an output dot to a slot dot. The dot is the target, so the wire lands on the slot, not the node. */
  const startWire = (nodeId: string, portId: string) => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const p = toBoardXY(e);
    setWiring({ from: { nodeId, portId }, x: p.x, y: p.y });
  };
  useEffect(() => {
    if (!wiring) return;
    const move = (ev: PointerEvent) => { const p = toBoardXY(ev); setWiring((w) => w && { ...w, x: p.x, y: p.y }); };
    const up = () => setTimeout(() => setWiring(null), 0);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [wiring, toBoardXY]);
  const landWire = (toNode: BoardNode, slotId: string) => (e: RPointerEvent) => {
    const b = latest.current;
    if (!wiring || !b) return;
    e.stopPropagation();
    if (wiring.from.nodeId === toNode.id) { setWiring(null); return; }
    const from = b.nodes.find((n) => n.id === wiring.from.nodeId);
    const kind: BoardWire["kind"] = slotId === "takes" ? "filed" : toNode.kind === "shot" && from?.kind === "asset" && wiring.from.portId !== "out" ? "override" : "inherited";
    const wire: BoardWire = { id: nid("wr"), from: wiring.from, to: { nodeId: toNode.id, slotId }, kind };
    const keep = slotId === "refs";
    const wires = b.wires.filter((w) => keep || !(w.to.nodeId === toNode.id && w.to.slotId === slotId)).concat(wire);
    const nodes = b.nodes.map((n) => (n.id === toNode.id ? { ...n, inputs: n.inputs.map((i) => (i.id === slotId ? { ...i, from: wiring.from } : i)), settings: slotId === "refs" ? { ...n.settings, refs: wires.filter((w) => w.to.nodeId === n.id && w.to.slotId === "refs").length } : n.settings } : n));
    let next: Board = { ...b, nodes, wires };
    next = { ...next, nodes: markStale(next, toNode.id) };
    commit(next); setWiring(null);
    toast(`${from?.label ?? "Output"} → ${toNode.label} · ${slotId.toUpperCase()}`);
  };

  const addAsset = (el: ElementFull) => addNode("asset", undefined, undefined, {
    label: `@${el.name}`, ref: { elementId: el.id },
    ports: el.attributes.map((a) => { const cur = a.versions.findIndex((v) => v.id === a.currentId); return { id: a.id, label: (a.label || a.kind).toUpperCase(), version: a.currentId ? `v${cur >= 0 ? cur + 1 : a.versions.length || 1}` : null, attributeId: a.id, versionId: a.currentId ?? null, idle: !a.currentId }; }),
    settings: { kind: el.kind, locked: Boolean(el.locked) },
  });
  const addShot = useCallback((s: ShotRow) => addNode("shot", undefined, undefined, {
    label: s.code, ref: { shotId: s.id }, settings: { title: s.description || s.title, takes: s.takes, spent: money.inCredits ? (s.credits ?? 0) : s.spend },
  }), [addNode, money.inCredits]);
  const removeNode = (id: string) => {
    const b = latest.current;
    if (!b) return;
    commit({ ...b, nodes: b.nodes.filter((n) => n.id !== id), wires: b.wires.filter((w) => w.from.nodeId !== id && w.to.nodeId !== id) });
    setSelected(null);
  };

  /* `?shot=` from the grid's `Open in Rig`: the shot lands on the board once. */
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!shownBoard || !shotFromUrl || !shotsData || seeded.current === shotFromUrl) return;
    seeded.current = shotFromUrl;
    if (shownBoard.nodes.some((n) => n.ref?.shotId === shotFromUrl)) return;
    const s = shotsData.shots.find((x) => x.id === shotFromUrl);
    if (s) addShot(s);
  }, [shownBoard, shotFromUrl, shotsData, addShot]);
  /* `?ref=` from the Library's `Add to Canvas` (§11): the reference lands as a note carrying its picture. */
  const refFromUrl = search.get("ref");
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shownBoard || !refFromUrl || seededRef.current === refFromUrl) return;
    seededRef.current = refFromUrl;
    if (shownBoard.nodes.some((n) => n.kind === "note" && n.output?.url === `/api/uploads/${encodeURIComponent(refFromUrl)}`)) return;
    /* The one upload, by id (not a scan of the newest page), for its name and real kind. A reference that is
       gone is said, not placed: it would only make every later save of this board fail. */
    fetch(`/api/uploads/${encodeURIComponent(refFromUrl)}/metadata`).then(async (r) => {
      if (r.status === 404) { toast("That reference isn't in the Library any more."); return; }
      if (!r.ok) throw new Error(String(r.status));
      const u = ((await r.json()) as { upload?: { filename?: string; kind?: string } }).upload;
      const name = u?.filename || "Reference";
      addNode("note", undefined, undefined, { label: name, text: `REF · ${name}`, output: { url: `/api/uploads/${encodeURIComponent(refFromUrl)}`, kind: u?.kind === "video" ? "video" : "image" } });
    }).catch(() => toast("The reference didn't reach the board. Add it again from the Library."));
  }, [shownBoard, refFromUrl, addNode, toast]);

  /* ── running a node: through the ordinary generate route; the output lives in the node ── */
  const runNode = async (n: BoardNode) => {
    const b = latest.current;
    if (!b || running.has(n.id) || !isGen(n.kind)) return;
    if (n.kind !== "image" && n.kind !== "video") { toast(`${KIND_WORD[n.kind]} nodes run from Make for now.`); return; }
    const price = priceOf(n);
    const upstream = (slotId: string) => { const w = b.wires.find((x) => x.to.nodeId === n.id && x.to.slotId === slotId); return w ? b.nodes.find((x) => x.id === w.from.nodeId) ?? null : null; };
    const specNode = upstream("spec") ?? upstream("image");
    const shotNode = [specNode, ...b.nodes.filter((x) => x.kind === "shot" && b.wires.some((w) => w.from.nodeId === x.id && w.to.nodeId === n.id))].find((x) => x?.kind === "shot") ?? null;
    const shot = shotNode?.ref?.shotId ? shotsData?.shots.find((s) => s.id === shotNode.ref!.shotId) ?? null : null;
    const promptNode = b.nodes.find((x) => x.kind === "prompt" && b.wires.some((w) => w.from.nodeId === x.id && w.to.nodeId === n.id));
    const imageNode = upstream("image");
    const prompt = [String(n.settings.prompt ?? ""), promptNode?.text ?? "", shot?.description ?? shot?.title ?? "", n.kind === "video" ? String(n.settings.motion ?? "") : ""].filter(Boolean).join(". ").trim();
    if (!prompt) { toast("Wire a prompt or a shot in first."); return; }
    setRunning((r) => new Set(r).add(n.id));
    patchNode(n.id, { state: "running" });
    try {
      const engine = engineOf(n);
      const body = n.kind === "image"
        ? { prompt, model: engine, projectId, shotId: shot?.id, resolution: n.settings.resolution ?? "1K", ratio: n.settings.ratio ?? "16:9" }
        : { prompt, model: engine, projectId, shotId: shot?.id, resolution: n.settings.resolution ?? "1080p", ratio: n.settings.ratio ?? "16:9", duration: Number(n.settings.seconds ?? 5),
            references: imageNode?.output?.genId ? [{ genId: imageNode.output.genId, role: "first_frame" }] : undefined };
      const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) { patchNode(n.id, { state: "failed" }); toast(j.error ?? "That node didn't run."); return; }
      const started = Date.now();
      /* The render is asynchronous; the node waits on it the way a take does. */
      let gen: Generation | null = null;
      for (let i = 0; i < 400; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const g = await fetch(`/api/jobs/${j.id}`).then((x) => x.json()).catch(() => ({}));
        gen = (g.generation ?? null) as Generation | null;
        if (gen && (gen.status === "succeeded" || gen.status === "failed" || gen.status === "cancelled")) break;
      }
      if (!gen || gen.status !== "succeeded") { patchNode(n.id, { state: "failed" }); toast(gen?.error ?? `${n.label} didn't finish.`); return; }
      const url = gen.storedUrl ?? gen.sourceUrl ?? null;
      const filedTo = gen.shotId ? { shotId: gen.shotId, version: Number(gen.version ?? 0) } : null;
      const charged = money.inCredits ? (gen.creditsBilled ?? price) : (gen.costUsd ?? price);
      const output: BoardNode["output"] = { genId: gen.id, url, kind: n.kind === "image" ? "image" : "video", label: gen.shotCode ? `${gen.shotCode} v${gen.version}` : null, filedTo, tookMs: Date.now() - started, ...(n.kind === "image" ? { variants: [{ genId: gen.id, url, chosen: true }] } : {}) };
      /* Filing draws its own wire: dashed, from the node's output to the shot's TAKES dot (§8). */
      const cur = latest.current ?? b;
      const wires = shotNode && filedTo
        ? cur.wires.filter((w) => !(w.kind === "filed" && w.from.nodeId === n.id)).concat({ id: nid("wr"), from: { nodeId: n.id, portId: "out" }, to: { nodeId: shotNode.id, slotId: "takes" }, kind: "filed" })
        : cur.wires;
      const nodes = cur.nodes.map((x) => x.id === n.id ? { ...x, state: "done" as const, credits: charged, staleSince: null, output }
        : shotNode && x.id === shotNode.id && filedTo ? { ...x, settings: { ...x.settings, takes: Number(x.settings.takes ?? 0) + 1, spent: Number(x.settings.spent ?? 0) + charged }, output: { filedTo } } : x);
      commit({ ...cur, nodes, wires });
      toast(`${n.label} ran · ${fmt(charged)}${gen.shotCode ? ` · filed to ${gen.shotCode} as v${gen.version}` : ""}`);
    } finally {
      setRunning((r) => { const s = new Set(r); s.delete(n.id); return s; });
    }
  };
  const runUnrun = async () => { for (const n of latest.current?.nodes ?? []) if ((n.kind === "image" || n.kind === "video") && !n.output?.genId) await runNode(n); };

  /* `Save as recipe`: the board's generate nodes become stages, in board order, each with its engine and its price. */
  const saveAsRecipe = async () => {
    const b = latest.current;
    if (!projectId || !b) return;
    /* Only what the board can run and price; an unrunnable node would enter the recipe at 0 cr. */
    const gens = b.nodes.filter((n) => isRunnable(n.kind)).sort((p, q) => p.x - q.x || p.y - q.y);
    const numOf = new Map(gens.map((n, i) => [n.id, i + 1]));
    const seen = new Map<string, number>();
    const stages = gens.map((n, i) => ({
      /* A stage is named for what it makes — `Image`, `Video 2` — and carries its engine beside it, the way the run track reads. */
      num: i + 1, name: (() => { const k = (seen.get(n.kind) ?? 0) + 1; seen.set(n.kind, k); return k > 1 ? `${KIND_WORD[n.kind]} ${k}` : KIND_WORD[n.kind]; })(), kind: "render",
      engine: engineOf(n), units: Number(n.settings.count ?? 1), credits: priceOf(n),
      inputs: b.wires.filter((w) => w.to.nodeId === n.id && numOf.has(w.from.nodeId)).map((w) => numOf.get(w.from.nodeId)!),
    }));
    const r = await fetch(`/api/rig/recipe/${encodeURIComponent(projectId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.name, stages }) });
    const j = await r.json().catch(() => ({}));
    toast(r.ok ? `Saved as a recipe · ${stages.length} stages` : (j.error ?? "This project already has a recipe."));
    if (r.ok) router.push(`/rig/recipes/${encodeURIComponent(projectId)}`);
  };

  /* ⌘K adds a node; Backspace removes the selected one; Esc drops a wire or the menu. */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setAddMenu({ x: 76 + 16, y: 56 + 44 + 16 + 36 + 6 }); }
      else if (e.key === "Escape") { setAddMenu(null); setWiring(null); }
      else if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); removeNode(selected); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to open the Rig.</div>;
  if (!wantsNew && loadStatus === 404) return <div className="p-[24px] text-[13px] text-ink-body">No such board. Open a project&rsquo;s Rig from its Shots grid.</div>;
  if (wantsNew && !projectFromUrl) return <Stuck line="A board belongs to a project. Open a project’s Rig from its Shots grid." />;
  if (wantsNew && openError) return <Stuck line={`Couldn’t open the board. ${openError}`} onRetry={() => { setOpenError(null); setOpenAttempt((n) => n + 1); }} />;
  if (!wantsNew && !loaded && loadError) return <Stuck line={`Couldn’t open the board. ${loadError}`} onRetry={reloadBoard} />;
  /* The productions only name the chip, so the board does not wait on them. */
  if (wantsNew || !shownBoard) return <PageLoader what="Opening · Canvas" />;
  const b = shownBoard;

  const sel = b.nodes.find((n) => n.id === selected) ?? null;
  const ran = b.nodes.filter((n) => n.output?.genId).length;
  const spent = b.nodes.reduce((a, n) => a + (n.output?.genId ? n.credits : 0), 0);
  const unrun = b.nodes.filter((n) => (n.kind === "image" || n.kind === "video") && !n.output?.genId);
  const unrunCost = unrun.reduce((a, n) => a + priceOf(n), 0);
  const hrefs = rigHrefs(projectId ?? "", b.id);
  const addItems: MenuItem[] = [
    { kind: "item", label: "New asset", keys: fmt(0), onSelect: () => setAssetSheet(true) },
    { kind: "divider" },
    ...(elements?.elements ?? []).slice(0, 8).map((el): MenuItem => ({ kind: "item", label: `@${el.name}`, keys: el.kind.toUpperCase(), onSelect: () => { addAsset(el); } })),
    ...((elements?.elements ?? []).length ? [{ kind: "divider" } as MenuItem] : []),
    ...(shotsData?.shots ?? []).slice(0, 8).map((s): MenuItem => ({ kind: "item", label: `${s.code} · ${s.description || s.title || "shot"}`.slice(0, 40), keys: "SHOT", onSelect: () => { addShot(s); } })),
    ...((shotsData?.shots ?? []).length ? [{ kind: "divider" } as MenuItem] : []),
    ...ADDABLE_KINDS.filter((k) => k !== "asset" && k !== "shot").map((k): MenuItem => ({ kind: "item", label: KIND_WORD[k], keys: KIND_TAG[k], onSelect: () => { addNode(k); } })),
  ];

  if (phone) {
    const gens = b.nodes.filter((n) => n.kind === "image" || n.kind === "video");
    const target = gens.find((n) => n.id === selected) ?? gens[gens.length - 1] ?? null;
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <RigBar tab="canvas" hrefs={hrefs}
          chip={<>{production?.name ?? "Project"} <span className="text-ink-muted">·</span> {b.name}</>}
          mono={`${b.nodes.length} nodes · ${ran} run · ${fmt(spent)} spent · building is free`}
          phoneTitle={b.name} phoneMono={`${b.nodes.length} nodes · ${fmt(spent)} spent`} />
        <SaveBanner state={saveState} onRetry={() => saver.current?.saver.retry()} />
        <PhoneBoard board={b} fmt={fmt} priceOf={priceOf} running={running} selected={selected} onSelect={setSelected} onRun={runNode}
          slot={slotSel} onSlot={setSlotSel} shots={shotsData?.shots ?? []} elements={elements?.elements ?? []} engineOf={engineOf} rates={rates} projectId={projectId}
          onRebind={(assetNodeId, portId, versionId, version) => {
            const cur = latest.current; if (!cur) return;
            const nodes = cur.nodes.map((n) => (n.id === assetNodeId ? { ...n, ports: n.ports.map((p) => (p.id === portId ? { ...p, versionId, version } : p)) } : n));
            let next: Board = { ...cur, nodes };
            next = { ...next, nodes: markStale(next, assetNodeId) };
            commit(next);
          }}
          toast={toast} />
        <div className="flex flex-none flex-col gap-[8px] border-t border-border bg-ground px-[16px] pb-[6px] pt-[10px]" data-pinned="">
          <Mono className="text-center">Built on desktop · run and file from here</Mono>
          <button type="button" disabled={!target || running.has(target.id)} onClick={() => target && runNode(target)} data-render=""
            className={`flex h-[50px] w-full items-center justify-between rounded-mobile px-[16px] text-[15px] font-semibold leading-none ${!target || rail.open || slotSel ? "border border-[rgba(245,246,248,.2)] bg-transparent text-ink-body" : "bg-action text-on-action hover:bg-action-hover"}`}>
            <span className="truncate">{target && running.has(target.id) ? "Running…" : target?.output?.genId ? "Run node again" : "Run node"}</span>
            <span className={`ui-mono ui-mono-cost !text-[12px] ${!target || rail.open || slotSel ? "text-ink-muted" : "text-on-primary-cost"}`}>{fmt(target ? priceOf(target) : 0)}</span>
          </button>
        </div>
        <NewAssetSheet open={assetSheet} from="rig" onClose={() => setAssetSheet(false)} onCreated={() => refreshElements()} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <RigBar tab="canvas" hrefs={hrefs}
        chip={<>{production?.name ?? "Project"} <span className="text-ink-muted">·</span> {b.name}<span className="text-[9px] text-ink-muted">▼</span></>}
        mono={`${b.nodes.length} nodes · ${ran} run · ${fmt(spent)} spent · building is free`}
        right={<>
          <span className="flex pl-[6px] max-md:hidden"><Avatar name={myName} you /></span>
          <Button placement="header" className="!h-[34px] !px-[12px]" onClick={() => navigator.clipboard?.writeText(location.href).then(() => toast("Link copied"))}>Share</Button>
          <Button placement="header" className="!h-[34px] !px-[12px]" onClick={saveAsRecipe}>Save as recipe</Button>
        </>} />
      <SaveBanner state={saveState} onRetry={() => saver.current?.saver.retry()} />
      <div className="grid min-h-0 flex-1 grid-cols-[56px_minmax(0,1fr)_300px]">
        <RigStrip />
        <section ref={surface} onPointerDown={onSurfaceDown} onContextMenu={(e) => { e.preventDefault(); setAddMenu({ x: e.clientX, y: e.clientY }); }}
          aria-label="Board"
          className={`relative min-w-0 overflow-hidden ${tool === "hand" ? "cursor-grab" : tool === "wire" ? "cursor-crosshair" : ""}`}
          style={{ backgroundImage: "radial-gradient(rgba(245,246,248,.07) 1px, transparent 1px)", backgroundSize: "24px 24px", backgroundPosition: `${pan.x}px ${pan.y}px` }}>
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <Wires board={b} selected={selectedWire} onSelect={setSelectedWire} wiring={wiring} />
            {b.nodes.map((n) => (
              <Node key={n.id} n={n} board={b} selected={selected === n.id} running={running.has(n.id)} price={priceOf(n)} fmt={fmt}
                onDown={onNodeDown(n)} onStartWire={startWire} onLand={landWire} onRun={() => runNode(n)}
                onText={(t) => patchNode(n.id, { text: t }, true)} onSetting={(k, v) => patchNode(n.id, { settings: { ...n.settings, [k]: v } }, true)} />
            ))}
          </div>
          <div className="absolute left-[16px] top-[16px] z-[4] flex gap-[6px]">
            <button type="button" onClick={(e) => { e.stopPropagation(); setAddMenu({ x: e.clientX - 20, y: e.clientY + 24 }); }} onPointerDown={(e) => e.stopPropagation()}
              className="flex h-[36px] items-center gap-[8px] rounded-pill bg-action pl-[10px] pr-[12px] text-[13px] font-medium leading-none text-on-action hover:bg-action-hover">
              <span className="text-[16px] leading-none">+</span>Add node<span className="ui-mono ui-mono-cost text-on-primary-cost">⌘K</span>
            </button>
            <span className="flex h-[36px] items-center whitespace-nowrap rounded-pill border border-[rgba(245,246,248,.12)] bg-card px-[12px] text-[12.5px] leading-none text-ink-body max-md:hidden">
              {ADDABLE_KINDS.map((k) => KIND_WORD[k]).join(" · ")}
            </span>
          </div>
          <div className="absolute bottom-[16px] left-1/2 z-[4] flex -translate-x-1/2 items-center gap-[2px] rounded-pill border border-[rgba(245,246,248,.12)] bg-card p-[4px]" role="toolbar" aria-label="Tools" onPointerDown={(e) => e.stopPropagation()}>
            {(["select", "hand", "wire", "note"] as Tool[]).map((t) => (
              <button key={t} type="button" aria-pressed={tool === t} onClick={() => setTool(t)} className={`rounded-pill px-[12px] py-[8px] text-[12.5px] font-medium leading-none ${tool === t ? "bg-selected text-ink" : "text-ink-body"}`}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
            <span className="mx-[6px] h-[18px] w-px bg-border-mid" />
            <button type="button" onClick={() => setZoom((z) => (z >= 1 ? 0.75 : z >= 0.75 ? 0.5 : 1))} className="ui-mono ui-mono-cost px-[10px] py-[8px] text-ink-body">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }} className="rounded-pill px-[12px] py-[8px] text-[12.5px] font-medium leading-none text-ink-body">Fit</button>
            <span className="mx-[6px] h-[18px] w-px bg-border-mid" />
            <button type="button" onClick={runUnrun} disabled={!unrun.length} className="ui-mono ui-mono-cost px-[12px] py-[8px] text-ink-body disabled:opacity-60">Run unrun · {fmt(unrunCost)}</button>
          </div>
          {/* The menu sits on the surface, whose pointerdown clears it: without this a
              press on an item closed the menu before its click, and nothing was added. */}
          {addMenu && <div className="contents" onPointerDown={(e) => e.stopPropagation()}><Menu x={addMenu.x} y={addMenu.y} title="Add node" items={addItems} onClose={() => setAddMenu(null)} /></div>}
          <NewAssetSheet open={assetSheet} from="rig" onClose={() => setAssetSheet(false)} onCreated={() => refreshElements()} />
        </section>
        <Inspector node={sel} board={b} price={sel ? priceOf(sel) : 0} fmt={fmt} engines={engines} engineOf={engineOf} shots={shotsData?.shots ?? []} production={production} projectId={projectId}
          onRun={() => sel && runNode(sel)} onSetting={(k, v) => sel && patchNode(sel.id, { settings: { ...sel.settings, [k]: v } }, true)}
          onEngine={(id) => sel && patchNode(sel.id, { ref: { ...(sel.ref ?? {}), engine: id }, label: engineLabel(id) }, true)}
          onRemove={() => sel && removeNode(sel.id)} running={sel ? running.has(sel.id) : false} />
      </div>
    </div>
  );
}

/* ── wires ─────────────────────────────────────────────────────────── */
function Wires({ board, selected, onSelect, wiring }: { board: Board; selected: string | null; onSelect: (id: string | null) => void; wiring: Wiring | null }) {
  const from = wiring ? board.nodes.find((n) => n.id === wiring.from.nodeId) : null;
  const start = from ? (wiring!.from.portId === "out" ? outputPoint(from) : portPoint(from, Math.max(0, from.ports.findIndex((p) => p.id === wiring!.from.portId)))) : null;
  const labels: { x: number; y: number; text: string; key: string }[] = [];
  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0 z-[2] overflow-visible" width={1} height={1} aria-hidden="true">
        {board.wires.map((w) => {
          const e = endpoints(board, w); if (!e) return null;
          const on = selected === w.id;
          const stroke = on ? "var(--ink)" : w.kind === "override" ? "var(--ink)" : w.kind === "inherited" ? "rgba(245,246,248,.3)" : "rgba(245,246,248,.35)";
          const width = on ? 2 : w.kind === "override" ? 2.5 : 1.5;
          if (w.kind === "filed") {
            const to = board.nodes.find((n) => n.id === w.to.nodeId);
            const m = wireMid(e.a, e.b);
            labels.push({ x: m.x, y: m.y, key: w.id, text: `Filed to ${to?.label ?? "shot"}${to?.output?.filedTo ? ` as v${to.output.filedTo.version}` : ""} · draft` });
          }
          return (
            <g key={w.id}>
              <path d={wirePath(e.a, e.b)} fill="none" stroke="transparent" strokeWidth={12} className="pointer-events-auto cursor-pointer" onPointerDown={(ev) => { ev.stopPropagation(); onSelect(w.id); }} />
              <path d={wirePath(e.a, e.b)} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={w.kind === "filed" || w.kind === "created" ? "4 4" : undefined} />
            </g>
          );
        })}
        {wiring && start && <path d={wirePath(start, { x: wiring.x, y: wiring.y })} fill="none" stroke="var(--ink)" strokeWidth={2} strokeDasharray="4 4" />}
      </svg>
      {labels.map((l) => (
        <span key={l.key} className="ui-mono absolute z-[2] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap bg-ground px-[8px]" style={{ left: l.x, top: l.y }}>{l.text}</span>
      ))}
    </>
  );
}

/* ── one node, by kind ─────────────────────────────────────────────── */
/** A port dot: 8px, on the node's edge (`right:-5px` / `left:-15px` in a padded row), z-index 3. */
function Dot({ style, dashed, onDown, onUp, title }: { style: React.CSSProperties; dashed?: boolean; onDown?: (e: RPointerEvent) => void; onUp?: (e: RPointerEvent) => void; title?: string }) {
  return (
    <span role="button" aria-label={title} data-dot="" onPointerDown={onDown} onPointerUp={onUp}
      className={`absolute z-[3] box-border h-[8px] w-[8px] rounded-full ${dashed ? "border-[1.5px] border-dashed border-ink-muted" : "bg-ink"} ${onDown || onUp ? "cursor-crosshair" : ""}`}
      style={style} />
  );
}

function Node({ n, board, selected, running, price, fmt, onDown, onStartWire, onLand, onRun, onText, onSetting }: {
  n: BoardNode; board: Board; selected: boolean; running: boolean; price: number; fmt: (v: number) => string;
  onDown: (e: RPointerEvent) => void; onStartWire: (nodeId: string, portId: string) => (e: RPointerEvent) => void;
  onLand: (to: BoardNode, slotId: string) => (e: RPointerEvent) => void; onRun: () => void; onText: (t: string) => void; onSetting: (k: string, v: unknown) => void;
}) {
  const w = NODE_W[n.kind];
  const tag = <span className="ui-mono rounded-badge border border-border-mid px-[4px] py-[3px] !text-[9.5px] !tracking-[.08em] text-ink-body">{KIND_TAG[n.kind]}</span>;
  const box = `absolute box-border rounded-card border ${selected ? "border-ink ui-node-selected" : n.kind === "shot" ? "border-border-mid" : "border-[rgba(245,246,248,.12)]"} ${n.settings.locked ? "bg-card-raised" : "bg-card"}`;
  const stale = n.state === "stale";
  const inputOf = (slotId: string) => { const wire = board.wires.find((x) => x.to.nodeId === n.id && x.to.slotId === slotId); return wire ? board.nodes.find((x) => x.id === wire.from.nodeId) ?? null : null; };
  const refsIn = board.wires.filter((x) => x.to.nodeId === n.id && x.to.slotId === "refs");
  const stop = (e: RPointerEvent) => e.stopPropagation();

  if (n.kind === "asset") {
    return (
      <article className={box} style={{ left: n.x, top: n.y, width: w }} onPointerDown={onDown} aria-label={`${KIND_WORD[n.kind]} ${n.label}`}>
        <div className="relative flex h-[32px] items-center gap-[6px] px-[10px]">
          {tag}<span className="text-[13px] font-semibold leading-none text-ink">{n.label}</span>
          <Mono cost className={n.settings.locked ? "" : "ml-auto"}>{String(n.settings.kind ?? "")}</Mono>
          {Boolean(n.settings.locked) && <LockGlyph />}
          <Dot style={{ right: -5, top: 12 }} onDown={onStartWire(n.id, "out")} title="all current" />
        </div>
        {n.ports.map((p) => (
          <div key={p.id} className="relative box-border h-[38px] px-[10px] pb-[6px]">
            <span className={`relative block h-[32px] overflow-hidden rounded-[7px] border border-border ui-placeholder ${p.idle ? "opacity-50" : ""}`}>
              <span className="ui-chip-scrim absolute left-[5px] top-[6px] rounded-badge px-[5px] py-[4px]"><span className="ui-mono text-ink">{p.label}</span></span>
              {p.version && <span className="ui-chip-scrim absolute right-[5px] top-[6px] rounded-badge px-[5px] py-[4px]"><span className="ui-mono tracking-normal text-ink-body">{p.version}</span></span>}
            </span>
            <Dot style={{ right: -5, top: 12 }} dashed={p.idle} onDown={onStartWire(n.id, p.id)} title={p.label} />
          </div>
        ))}
      </article>
    );
  }
  if (n.kind === "shot") {
    const takes = Number(n.settings.takes ?? 0);
    const specTop = outputDotTop(n);
    return (
      <article className={box} style={{ left: n.x, top: n.y, width: w }} onPointerDown={onDown} aria-label={`Shot ${n.label}`}>
        <div className="flex h-[36px] items-center gap-[8px] px-[10px]">
          {tag}<Mono tone="ink">{n.label}</Mono><span className="min-w-0 truncate text-[13px] font-semibold leading-[1.2] text-ink">{String(n.settings.title ?? "")}</span>
        </div>
        <div className="flex flex-col px-[10px] pt-[8px]">
          {n.inputs.map((slot) => {
            const src = inputOf(slot.id);
            return (
              <div key={slot.id} className="relative box-border flex h-[40px] items-center gap-[8px]">
                <Dot style={{ left: -15, top: 16 }} onUp={onLand(n, slot.id)} title={slot.label} />
                <span className={`ml-[4px] flex h-[32px] w-[54px] flex-none items-center justify-center rounded-[5px] border border-border ${slot.id === "prompt" ? "bg-ground" : "ui-placeholder"}`}><span className="ui-mono !text-[9.5px] tracking-normal text-ink-muted">{src ? src.label.replace(/^@/, "").slice(0, 4).toUpperCase() : slot.id === "prompt" ? "TXT" : "—"}</span></span>
                <Mono className="whitespace-nowrap">{slot.label}</Mono>
                <span className="ml-auto mr-[4px] ui-mono whitespace-nowrap tracking-normal text-ink-body">{src ? (src.kind === "asset" ? "current" : src.kind === "prompt" ? "1 line" : src.label) : "—"}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-[6px] box-border flex h-[30px] items-center justify-between border-t border-border px-[10px]">
          <Mono className="whitespace-nowrap">{takes} {takes === 1 ? "take" : "takes"} · {fmt(Number(n.settings.spent ?? 0))}</Mono>
          <Mono tone="ink" className="whitespace-nowrap">{n.output?.filedTo ? `v${n.output.filedTo.version} new` : ""}</Mono>
        </div>
        <Dot style={{ right: -5, top: specTop }} onDown={onStartWire(n.id, "out")} title="SPEC" />
        <Mono className="absolute -right-[48px] whitespace-nowrap" style={{ top: specTop + 11 }}>Spec</Mono>
        <Dot style={{ left: TAKES_DOT_LEFT, bottom: -5 }} dashed={!board.wires.some((x) => x.to.nodeId === n.id && x.to.slotId === "takes")} onUp={onLand(n, "takes")} title="TAKES" />
        <Mono className="absolute -bottom-[24px] left-[96px] whitespace-nowrap">← Takes</Mono>
      </article>
    );
  }
  if (n.kind === "prompt" || n.kind === "note") {
    return (
      <article className={box} style={{ left: n.x, top: n.y, width: w }} onPointerDown={onDown} aria-label={`${KIND_WORD[n.kind]} node`}>
        <div className="flex h-[32px] items-center gap-[6px] px-[10px]">{tag}<span className="text-[13px] font-semibold leading-none text-ink">{KIND_WORD[n.kind]}</span><Mono cost className="ml-auto">{n.kind === "prompt" ? "free" : ""}</Mono></div>
        <textarea value={n.text ?? ""} onChange={(e) => onText(e.target.value)} onPointerDown={stop} placeholder={n.kind === "prompt" ? "@Noor's hands on @The bag…" : "A note"} aria-label={KIND_WORD[n.kind]}
          className="mx-[10px] mb-[10px] box-border h-[96px] w-[calc(100%-20px)] resize-none rounded-ctl border border-[rgba(245,246,248,.1)] bg-ground px-[10px] py-[8px] text-[13px] leading-[1.45] text-ink outline-0 placeholder:text-ink-muted" />
        {n.kind === "prompt" && <Dot style={{ right: -5, top: 77 }} onDown={onStartWire(n.id, "out")} title="Prompt" />}
      </article>
    );
  }
  /* image · video · edit · upscale · audio · voice · compare */
  const done = Boolean(n.output?.genId);
  const runnable = isRunnable(n.kind);
  const dotTop = outputDotTop(n);
  const secs = Number(n.settings.seconds ?? 5);
  return (
    <article className={box} style={{ left: n.x, top: n.y, width: w }} onPointerDown={onDown} aria-label={`${KIND_WORD[n.kind]} ${n.label}`}>
      <div className="flex h-[32px] items-center gap-[6px] px-[10px]">
        {tag}<span className="truncate text-[13px] font-semibold leading-none text-ink">{n.label}</span>
        {n.kind === "image" && <Mono cost className="ml-auto whitespace-nowrap">{String(n.settings.resolution ?? "1K")} · ×{Number(n.settings.count ?? 1)}</Mono>}
      </div>
      <div className="mx-[10px] mt-[8px] flex flex-col">
        {n.inputs.map((slot) => {
          const src = inputOf(slot.id);
          if (slot.id === "refs") {
            return (
              <div key={slot.id} className="relative flex h-[28px] items-center gap-[8px]">
                <Dot style={{ left: -15, top: 10 }} onUp={onLand(n, slot.id)} title={slot.label} />
                <Mono className="whitespace-nowrap">{slot.label}{refsIn.length ? ` · ${refsIn.length}` : ""}</Mono>
                <span className="ml-auto flex gap-[3px]">{refsIn.slice(0, 4).map((r) => <span key={r.id} className="h-[20px] w-[30px] rounded-[3px] border border-[rgba(245,246,248,.1)] ui-placeholder" />)}</span>
              </div>
            );
          }
          return (
            <div key={slot.id} className="relative flex h-[28px] items-center gap-[8px]">
              <Dot style={{ left: -15, top: 10 }} onUp={onLand(n, slot.id)} title={slot.label} />
              <Mono className="whitespace-nowrap">{slot.label}</Mono>
              <span className="ml-auto truncate text-[12px] leading-none text-ink-body">{src ? (src.kind === "shot" ? `${src.label} · ${src.inputs.length} slots` : src.output?.label ?? src.label) : "—"}</span>
            </div>
          );
        })}
        {n.kind === "video" && (
          <label className="box-border flex h-[44px] items-center gap-[4px] overflow-hidden rounded-[7px] border border-[rgba(245,246,248,.1)] bg-ground px-[8px] py-[5px] text-[12px] leading-[1.3] text-ink-body">
            <span className="ui-mono !text-[10px]">Motion</span>
            <input value={String(n.settings.motion ?? "")} onChange={(e) => onSetting("motion", e.target.value)} onPointerDown={stop} placeholder="Push in, slow. One move." aria-label="Motion"
              className="min-w-0 flex-1 bg-transparent text-[12px] leading-[1.3] text-ink-body outline-0 placeholder:text-ink-muted" />
          </label>
        )}
      </div>
      {n.kind === "image" ? (
        <div className="mx-[10px] mt-[8px] grid grid-cols-2 gap-[6px]">
          {[0, 1, 2, 3].map((i) => {
            const v = n.output?.variants?.[i] ?? (i === 0 && n.output?.url ? { genId: n.output.genId ?? "", url: n.output.url, chosen: true } : null);
            return (
              <span key={i} className={`relative box-border h-[64px] overflow-hidden rounded-[6px] border ui-placeholder ${v?.chosen ? "border-2 border-ink" : "border-[rgba(245,246,248,.1)]"}`}>
                {v?.url && <LazyMedia url={v.url} kind="image" className="absolute inset-0 h-full w-full object-cover" />}
                {running && i === 0 && <span className="absolute inset-0 flex items-center justify-center"><Loader size={LOADER_SIZES.message} /></span>}
                <span className="ui-chip-scrim absolute bottom-[4px] left-[4px] rounded-[3px] px-[4px] py-[3px]"><span className="ui-mono !text-[10px] tracking-normal text-ink">S{i + 1}</span></span>
                {v?.chosen && <span className="absolute right-[4px] top-[4px] rounded-[3px] bg-ink px-[4px] py-[3px] ui-mono !text-[9.5px] !tracking-[.06em] text-ground">Out</span>}
              </span>
            );
          })}
        </div>
      ) : (
        <div className={`relative mx-[10px] mt-[8px] box-border flex h-[89px] items-center justify-center overflow-hidden rounded-ctl border px-[10px] text-center ${done || running ? "border-border ui-placeholder" : "border-dashed border-[rgba(245,246,248,.2)] bg-ground"}`}>
          {running ? <Loader size={LOADER_SIZES.well} /> : done ? (
            <>
              {n.output?.url && <LazyMedia url={n.output.url} kind={n.output.kind === "image" ? "image" : "video"} className="absolute inset-0 h-full w-full object-cover" hoverPlay />}
              <span className="ui-chip-scrim relative flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[rgba(245,246,248,.2)] text-[11px] font-medium leading-none text-ink">▶</span>
              <span className="ui-chip-scrim absolute bottom-[5px] left-[5px] rounded-badge px-[5px] py-[3px]"><span className="ui-mono !text-[10px] !tracking-[.1em] text-ink">{n.kind === "video" ? `0:${String(secs).padStart(2, "0")} · ` : ""}{String(n.settings.resolution ?? "1080p")}</span></span>
              <span className="ui-chip-scrim absolute right-[5px] top-[5px] flex items-center gap-[4px] rounded-badge px-[5px] py-[3px]"><span className="block h-[6px] w-[6px] rounded-full bg-accent" /><span className="ui-mono !text-[10px] !tracking-[.1em] text-accent">Done</span></span>
            </>
          ) : <span className="ui-mono !text-[10px] !leading-[1.5] !tracking-[.1em] text-ink-muted">{stale ? "Stale · upstream changed" : n.kind === "video" && inputOf("image") ? "Not run · same frame other model" : "Not run"}</span>}
        </div>
      )}
      <button type="button" onClick={(e) => { e.stopPropagation(); onRun(); }} onPointerDown={stop} disabled={running || !runnable}
        className={`mx-[10px] mb-[10px] mt-[8px] box-border flex h-[40px] w-[calc(100%-20px)] items-center justify-between rounded-[9px] border border-[rgba(245,246,248,.16)] ${n.kind === "image" ? "px-[12px] text-[13px]" : "px-[10px] text-[12.5px]"} font-medium leading-none text-ink`}>
        <span className="truncate">{!runnable ? "Doesn’t run on a board" : done ? (n.output?.filedTo ? `Filed · ${board.nodes.find((x) => x.ref?.shotId === n.output?.filedTo?.shotId)?.label ?? "shot"} v${n.output.filedTo.version}` : n.kind === "image" ? `Again ×${Number(n.settings.count ?? 1)}` : "Again") : "Generate"}</span>
        {runnable && <Mono cost className="whitespace-nowrap">{fmt(done ? n.credits : price)}</Mono>}
      </button>
      <Dot style={{ right: -5, top: dotTop }} dashed={!done} onDown={onStartWire(n.id, "out")} title="Output" />
    </article>
  );
}

function LockGlyph() {
  return <svg viewBox="0 0 12 12" width="11" height="11" className="ml-auto" style={{ fill: "none", stroke: "var(--ink)", strokeWidth: 1.3 }} aria-hidden="true"><rect x="2" y="5.4" width="8" height="5.4" rx="1.2" /><path d="M4 5.4V4a2 2 0 0 1 4 0v1.4" /></svg>;
}

/* ── the inspector (300px) ─────────────────────────────────────────── */
function Inspector({ node: n, board, price, fmt, engines, engineOf, shots, production, projectId, onRun, onSetting, onEngine, onRemove, running }: {
  node: BoardNode | null; board: Board; price: number; fmt: (v: number) => string; engines: Engine[]; engineOf: (n: BoardNode) => string;
  shots: ShotRow[]; production: ProductionRow | null; projectId: string | null;
  onRun: () => void; onSetting: (k: string, v: unknown) => void; onEngine: (id: string) => void; onRemove: () => void; running: boolean;
}) {
  const router = useRouter();
  if (!n) {
    return (
      <aside className="flex min-h-0 flex-col border-l border-border max-md:hidden" aria-label="Inspector">
        <div className="flex flex-col gap-[7px] border-b border-border p-[16px]"><Mono>Board</Mono><span className="text-[18px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">{board.name}</span><span className="text-[13px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>Select a node to see its inputs, settings and output. Building is free; a node prices itself before it runs.</span></div>
      </aside>
    );
  }
  const inputs = n.inputs.map((i) => { const w = board.wires.find((x) => x.to.nodeId === n.id && x.to.slotId === i.id); const src = w ? board.nodes.find((x) => x.id === w.from.nodeId) ?? null : null; return { id: i.id, label: i.label, src }; });
  const shot = n.output?.filedTo ? shots.find((s) => s.id === n.output!.filedTo!.shotId) ?? null : null;
  const gen = n.kind === "image" || n.kind === "video";
  const engineId = gen ? engineOf(n) : "";
  const engine = engines.find((e) => e.id === engineId) ?? null;
  const choices = engines.filter((e) => e.kind === (n.kind === "image" ? "image" : "video"));
  const took = n.output?.tookMs ? Math.max(1, Math.round(n.output.tookMs / 60_000)) : null;
  const seed = n.settings.seed;
  return (
    <aside className="flex min-h-0 flex-col border-l border-border max-md:hidden" aria-label="Inspector">
      <div className="flex flex-none flex-col gap-[7px] border-b border-border p-[16px]">
        <Mono>Node · {KIND_WORD[n.kind]}{engine ? ` · ${engine.label}` : ""}</Mono>
        <span className="text-[18px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">{n.kind === "prompt" ? (n.text || "Prompt").slice(0, 40) : n.label}</span>
        <span className="text-[13px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>
          {n.state === "stale" ? "Something upstream changed. This node is stale; it will not re-run on its own."
            : n.output?.filedTo && shot ? `Its output is already filed to the shot as v${n.output.filedTo.version} (draft). Change anything upstream and this node goes stale instead of re-running on its own.`
            : gen ? "Prices itself before it runs; its output lives here and files to the shot as the next version."
            : n.kind === "asset" ? "Each port is one attribute at its current version. Drag from a port to a shot's slot to override it for that shot." : ""}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto p-[16px]">
        {inputs.length > 0 && (
          <div className="flex flex-col gap-[8px]">
            <Mono>Inputs</Mono>
            <div className="flex flex-col overflow-hidden rounded-tile bg-card">
              {inputs.map((i, k) => (
                <span key={i.id} className={`flex min-h-[44px] items-center gap-[10px] px-[12px] py-[10px] ${k ? "border-t border-[rgba(245,246,248,.07)]" : ""}`}>
                  {(i.id === "image" || i.id === "refs") && <span className="relative h-[26px] w-[40px] flex-none overflow-hidden rounded-badge border border-[rgba(245,246,248,.1)] ui-placeholder">{i.src?.output?.url && <LazyMedia url={i.src.output.url} kind="image" className="absolute inset-0 h-full w-full object-cover" />}</span>}
                  <span className="text-[13px] font-medium leading-[1.2] text-ink">{i.id === "spec" ? "Shot spec" : i.label[0] + i.label.slice(1).toLowerCase()}</span>
                  <Mono cost className="ml-auto truncate">{i.src ? (i.src.kind === "shot" ? `${i.src.label} · ${i.src.inputs.length} slots` : i.src.output?.label ?? i.src.label) : "—"}</Mono>
                </span>
              ))}
              {n.kind === "video" && <span className="flex min-h-[44px] items-center gap-[10px] border-t border-[rgba(245,246,248,.07)] px-[12px] py-[10px]"><span className="text-[13px] font-medium leading-[1.2] text-ink">Motion prompt</span><Mono cost className="ml-auto">Inline</Mono></span>}
            </div>
          </div>
        )}
        {gen && (
          <div className="flex flex-col gap-[8px]">
            <Mono>Settings</Mono>
            <div className="flex flex-wrap gap-[6px]">
              <label className="relative flex items-center rounded-pill border border-border-mid px-[11px] py-[8px] text-[12.5px] font-medium leading-none text-ink">
                <span>{engine?.label ?? engineId ?? "Engine"} <span className="text-[9px] text-ink-muted">▼</span></span>
                <select value={engineId} onChange={(e) => onEngine(e.target.value)} aria-label="Engine" className="absolute inset-0 cursor-pointer opacity-0">
                  {choices.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                  {!choices.some((e) => e.id === engineId) && engineId && <option value={engineId}>{engineId}</option>}
                </select>
              </label>
              {n.kind === "video" && (engine?.durations.length ? engine.durations : [5, 10]).map((s) => <Chip key={s} variant="filter" tone="ink" active={Number(n.settings.seconds ?? 5) === s} onClick={() => onSetting("seconds", s)}>{s}s</Chip>)}
              {(engine?.resolutions.length ? engine.resolutions : n.kind === "video" ? ["720p", "1080p"] : ["1K", "2K"]).map((r) => <Chip key={r} variant="filter" tone="ink" active={String(n.settings.resolution ?? (n.kind === "video" ? "1080p" : "1K")) === r} onClick={() => onSetting("resolution", r)}>{r.toUpperCase()}</Chip>)}
              {(engine?.ratios.length ? engine.ratios : ["16:9", "9:16", "1:1"]).map((r) => <Chip key={r} variant="filter" tone="ink" active={String(n.settings.ratio ?? "16:9") === r} onClick={() => onSetting("ratio", r)}>{r}</Chip>)}
              {n.kind === "video" && engine?.supportsAudio && <Chip variant="filter" tone="ink" active={Boolean(n.settings.audio)} onClick={() => onSetting("audio", !n.settings.audio)}>Audio {n.settings.audio ? "on" : "off"}</Chip>}
              {n.kind === "image" && [1, 2, 4].map((c) => <Chip key={c} variant="filter" tone="ink" active={Number(n.settings.count ?? 1) === c} onClick={() => onSetting("count", c)}>×{c}</Chip>)}
              {typeof seed === "number" && <Chip variant="filter" tone="ink"><span className="ui-mono ui-mono-cost">Seed {seed}</span></Chip>}
            </div>
          </div>
        )}
        {n.output?.genId && (
          <div className="flex flex-col gap-[10px] rounded-card border border-[rgba(245,246,248,.1)] bg-card p-[14px]">
            <span className="flex items-baseline justify-between"><Mono className="whitespace-nowrap">Output</Mono><span className="flex items-center gap-[5px] whitespace-nowrap ui-mono text-accent"><span className="block h-[6px] w-[6px] rounded-full bg-accent" />Done{took ? ` · ${took} min` : ""}</span></span>
            <span className="text-[13.5px] leading-[1.4] text-ink">{shot ? `${shot.code} v${n.output.filedTo?.version ?? ""} · draft${n.kind === "video" ? ` · 0:${String(Number(n.settings.seconds ?? 5)).padStart(2, "0")}` : ""} · ${fmt(n.credits)}. It shows on the Shots grid now; the director picks or approves it there.` : `${fmt(n.credits)} · unfiled. Wire a shot's spec in to file the next run.`}</span>
            <div className="flex gap-[6px]">
              <button type="button" onClick={() => production && projectId && router.push(`/productions/${production.id}/${projectId}/shots`)} className="flex min-h-[40px] flex-1 items-center justify-center rounded-[9px] border border-[rgba(245,246,248,.16)] text-[12.5px] font-medium leading-none text-ink">Open in Shots</button>
            </div>
          </div>
        )}
        <span className="text-[13px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>{gen ? "Wire the output into a video node’s image slot to start from this frame. Downstream nodes price themselves before they run." : "Drag from a dot on the right edge to a slot on another node to wire it."}</span>
        <button type="button" onClick={onRemove} className="self-start ui-mono text-ink-muted">Remove node ⌫</button>
      </div>
      {gen && (
        <div className="flex flex-none flex-col gap-[8px] border-t border-border px-[16px] pb-[16px] pt-[12px]">
          <Button variant="primary" placement="rail" cost={price} busy={running} busyLabel="Running…" onClick={onRun}>{n.output?.genId ? "Run node again" : "Run node"}</Button>
          {shot && <Mono cost className="text-center !leading-[1.4]">Files as {shot.code} v{(n.output?.filedTo?.version ?? 0) + 1} · v{n.output?.filedTo?.version} stays</Mono>}
        </div>
      )}
    </aside>
  );
}

/* ── a board that could not be opened, or saved ─────────────────────── */
function Stuck({ line, onRetry }: { line: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-[12px] p-[24px] text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>
      <span>{line}</span>
      {onRetry && <button type="button" onClick={onRetry} className="tap44 h-[44px] rounded-pill border border-border-mid px-[16px] text-[13px] font-medium leading-none text-ink">Retry</button>}
    </div>
  );
}

function SaveBanner({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.kind !== "failed" && state.kind !== "conflict") return null;
  return (
    <div role="alert" className="flex flex-none flex-wrap items-center gap-x-[12px] gap-y-[6px] border-b border-border bg-card px-[16px] py-[6px] text-[13px] leading-[1.4] text-ink">
      <span className="min-w-0 flex-1">{state.kind === "conflict" ? "Someone else changed this board. Your latest edits here are not saved." : `Not saved · ${state.message}`}</span>
      {state.kind === "conflict"
        ? <button type="button" onClick={() => window.location.reload()} className="tap44 h-[36px] rounded-pill border border-border-mid px-[14px] text-[13px] font-medium leading-none text-ink">Reload the board</button>
        : <button type="button" onClick={onRetry} className="tap44 h-[36px] rounded-pill border border-border-mid px-[14px] text-[13px] font-medium leading-none text-ink">Retry</button>}
    </div>
  );
}
