"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardCard } from "@/lib/board/types";
import type { Generation } from "@/lib/jobs";
import type { TakeCardData } from "@/components/graphite/board/cards/take/shots-derive";
import { useToast } from "@/components/v12/ui/Toast";
import { useTabTitle } from "@/components/v12/ui/tab-title";
import { useRenderStates, batchMeta } from "./use-render";

/**
 * The Shots stage as a batch (redesign P3; docs/redesign/inventory.md § 7): its stage meta ("3 of 8 ready · about 4 min
 * left"), the toast when a take lands ("Shot 3 is ready · View", bottom-centre), the browser tab's "(N ready) Particl", and
 * the opt-in "Tell me when it's done". Only takes that land while the board is open count: the first read is the baseline.
 * The browser notification is the page's own (the Notification API, asked for only on the press), never web push.
 */
type Shot = { nodeId: string; name: string; g: Generation };

const ASKED = "particl:notify-asked";
const readAsked = () => { try { return window.localStorage.getItem(ASKED) === "1"; } catch { return true; } };
const writeAsked = () => { try { window.localStorage.setItem(ASKED, "1"); } catch { /* asked again next time */ } };

export type Batch = {
  meta: string | null;
  /** The first take to run past a minute, when the browser can still be asked to tell the person. */
  offer: boolean;
  tellMe: () => Promise<void>;
  notNow: () => void;
};

export function useShotsBatch(opts: {
  cards: readonly BoardCard[];
  on: boolean;
  /** The shot's card, selected and glided to: the toast's View. */
  onView: (nodeId: string) => void;
  /** Cards the person has looked at (selected): they no longer count as waiting in the tab title. */
  selected: ReadonlySet<string>;
}): Batch {
  const { cards, on, onView, selected } = opts;
  const raise = useToast();
  const toast = useCallback((text: string, action?: { label: string; run: () => void }) => raise({ text, action }), [raise]);
  const shots = useMemo<Shot[]>(() => on ? cards.flatMap((c) => {
    if (c.kind !== "take") return [];
    const row = (c.data as TakeCardData).row;
    const v = row.shown;
    return v && v.entry.asset.origin === "generation" ? [{ nodeId: row.nodeId, name: `Shot ${row.index}`, g: v.entry.asset.value }] : [];
  }) : [], [cards, on]);
  const gens = useMemo(() => shots.map((s) => s.g), [shots]);
  const states = useRenderStates(gens);
  const meta = useMemo(() => batchMeta(shots.flatMap((s) => { const state = states.get(s.g.id); return state ? [{ name: s.name, state }] : []; })), [shots, states]);

  /* Takes that landed while the board was open. */
  const before = useRef<Map<string, string> | null>(null);
  const [landed, setLanded] = useState<string[]>([]);
  const [wants, setWants] = useState(false);
  const wantsRef = useRef(false);
  useEffect(() => {
    const now = new Map(shots.map((s) => [s.nodeId, s.g.status]));
    const was = before.current;
    before.current = now;
    if (!was || !on) return;
    const fresh = shots.filter((s) => s.g.status === "succeeded" && ["held", "queued", "running"].includes(was.get(s.nodeId) ?? ""));
    if (!fresh.length) return;
    setLanded((list) => [...new Set([...list, ...fresh.map((s) => s.nodeId)])]);
    for (const s of fresh) {
      toast(`${s.name} is ready`, { label: "View", run: () => onView(s.nodeId) });
      if (wantsRef.current && typeof document !== "undefined" && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification(`${s.name} is ready`, { body: "Open Particl to review it." }); } catch { /* the toast stands */ }
      }
    }
  }, [shots, on, toast, onView]);
  const waiting = landed.filter((id) => !selected.has(id));
  useTabTitle(on ? waiting.length : 0);

  /* "Tell me when it's done": offered once, on the first take over a minute. */
  const [asked, setAsked] = useState(true);
  useEffect(() => { setAsked(readAsked()); }, []);
  const slowOne = on && [...states.values()].some((s) => s.active && (s.elapsedMs ?? 0) > 60_000);
  const can = typeof Notification !== "undefined" && Notification.permission === "default";
  const tellMe = useCallback(async () => {
    writeAsked(); setAsked(true);
    try {
      const answer = await Notification.requestPermission();
      if (answer === "granted") { wantsRef.current = true; setWants(true); toast("We’ll tell you when it’s done · browser notification"); }
    } catch { /* the browser said no */ }
  }, [toast]);
  const notNow = useCallback(() => { writeAsked(); setAsked(true); }, []);
  void wants;
  return { meta, offer: slowOne && !asked && can, tellMe, notNow };
}
