"use client";
import { useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace/state";
import type { SampleLiftStatus } from "@/lib/demo/sample";
import { Btn, Note, Row, Section } from "../parts";
import { useRead, useWrite } from "../use-settings";

/**
 * Settings › Spending rules › Sample mark: only in the sample workspace, and only for its owner or an admin (the route
 * gives anyone else no record, and this then draws nothing). The mark refuses every paid step there; Lift for one run
 * opens it for the admin's next Atomik run, and it comes back on by itself when that run ends (lib/demo/lift.server.ts).
 * Below, who lifted it, when, for which run, and when it came back.
 */
type LiftWhy = "finished" | "failed" | "stopped" | "undone" | "gone" | "expired" | "put_back" | "unmarked";
type LiftRecord = {
  id: string; by: string; at: number; until: number; run: { id: string; goal: string | null } | null;
  backAt: number | null; why: LiftWhy | null; backBy: string | null;
};
type LiftReply = { marked: boolean; status: SampleLiftStatus; canLift?: boolean; record?: LiftRecord[] };

const when = (at: number) => new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const WHY: Record<LiftWhy, string> = {
  finished: "run finished", failed: "run failed", stopped: "run stopped", undone: "run undone", gone: "run gone",
  expired: "time ran out", put_back: "put back", unmarked: "mark undone",
};

function recordLine(r: LiftRecord): string {
  const run = r.run ? (r.run.goal ? `“${r.run.goal.length > 60 ? r.run.goal.slice(0, 59) + "…" : r.run.goal}”` : "one run") : "next run";
  const back = r.backAt == null ? "still lifted" : `back on ${clock(r.backAt)}, ${r.why === "put_back" && r.backBy ? `${r.backBy === "You" ? "you" : r.backBy} put it back` : WHY[r.why ?? "expired"]}`;
  return `${when(r.at)} · ${run} · ${back}`;
}

export function SampleLiftSection() {
  const { data, read } = useRead<LiftReply>("/api/demo/sample/lift");
  const write = useWrite();
  const { toast } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pressing = useRef(false);
  if (!data?.marked || !data.record) return null;
  const lifted = data.status.lifted;

  const press = async (body: Record<string, unknown>, said: string) => {
    if (pressing.current) return;
    pressing.current = true; setBusy(true); setNote(null);
    const { error } = await write("/api/demo/sample/lift", "POST", body);
    pressing.current = false; setBusy(false);
    void read();
    if (error) { setNote(error); return; }
    toast(said);
  };

  const line = lifted
    ? `${data.status.runId ? "For one Atomik run" : "For your next Atomik run on a board"}. Back on when it ends${data.status.expiresAt ? `, or at ${clock(data.status.expiresAt)}` : ""}.`
    : "Nothing in this workspace spends.";

  return (
    <Section label="Sample mark" meta={lifted ? "lifted for one run" : "on"} testId="settings-sample-mark">
      <Row name={lifted ? "Lifted for one run" : "On"} line={line} testId="settings-sample-state">
        {lifted
          ? <Btn disabled={busy} onClick={() => void press({ action: "putBack" }, "The sample mark is back on.")} testId="settings-sample-putback">Put back now</Btn>
          : <Btn hot disabled={busy || !data.canLift} onClick={() => void press({ action: "lift" }, "Lifted for your next Atomik run.")} testId="settings-sample-lift">Lift for one run</Btn>}
      </Row>
      {data.record.map((r) => (
        <Row key={r.id} name={`${r.by} lifted it`} line={recordLine(r)} testId="settings-sample-lift-row" />
      ))}
      {note ? <Note ok={false} text={note} testId="settings-sample-note" /> : null}
    </Section>
  );
}
