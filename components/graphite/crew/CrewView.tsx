"use client";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PromptAttach, resolveAttached, type Attached } from "@/components/PromptAttach";
import { readsLabel } from "@/lib/crew/context";
import { CONTEXT_LABELS, CREW_EFFORTS, CREW_PRESETS, PHASES, PHASE_LABEL, ROUNDS_MAX } from "@/lib/crew/room";
import { useCrew, type CrewRoom, type RoomMessage } from "@/lib/crew/use-crew";
import { CREW_PAGES } from "@/lib/shell/ia";
import { useShell } from "@/lib/shell/state";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import type { Project } from "@/lib/workbench/studio";
import { useWorkspace } from "@/lib/workspace/state";
import { uploadToProject } from "@/lib/workspace/library";

const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** 46px strip: 01 Room · 02 Members · 03 Sessions, and the engine's status pill. */
export function CrewStrip({ room }: { room: CrewRoom }) {
  const shell = useShell();
  const status = room.status;
  const ok = status?.connected ?? true;
  return (
    <nav className="gx-strip gx-scroll cw-strip" aria-label="Pages" data-row="strip">
      <span className="cw-strip-pages">
        {CREW_PAGES.map((p) => (
          <button key={p.id} type="button" className="gx-tab" aria-current={p.id === shell.crewPage ? "page" : undefined} title={p.title} onClick={() => shell.goCrew(p.id)}>
            <span className="gx-tab-n">{p.n}</span><span>{p.label}</span>
          </button>
        ))}
      </span>
      <span className="cw-engine" data-ok={ok} data-testid="crew-engine">
        <span className="cw-engine-dot" aria-hidden="true" />
        {ok ? `${status?.model ? status.model.replace(/^grok-/, "Grok ") : "Grok"} · multi-agent · xAI key connected` : "Add key in Workspace › Engines"}
      </span>
    </nav>
  );
}

export function CrewView({ project, room, scope, projectsError = null, onRetry }: { project: Project | null; room: CrewRoom; scope: string; projectsError?: string | null; onRetry?: () => void }) {
  const shell = useShell();
  const page = CREW_PAGES.find((p) => p.id === shell.crewPage)!;
  return (
    <div className="cw" data-testid="crew-view" data-page={page.id}>
      {page.id === "room" ? <Room project={project} room={room} scope={scope} projectsError={projectsError} onRetry={onRetry} /> : null}
      {page.id === "members" ? <Members room={room} title={page.title} hint={page.hint} /> : null}
      {page.id === "sessions" ? <Sessions room={room} title={page.title} hint={page.hint} /> : null}
    </div>
  );
}

/* ── Room ─────────────────────────────────────────────────────────────── */

function Room({ project, room, scope, projectsError, onRetry }: { project: Project | null; room: CrewRoom; scope: string; projectsError: string | null; onRetry?: () => void }) {
  const shell = useShell();
  const ws = useWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [say, setSay] = useState("");
  const [filing, setFiling] = useState(false);
  const toast = ws.toast;
  const end = useRef<HTMLDivElement>(null);
  const page = CREW_PAGES[0];
  const member = room.members.find((m) => m.id === selected) ?? null;
  const left = useMemo(() => CREW_PRESETS.filter((p) => !room.members.some((m) => m.presetId === p.id)), [room.members]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [room.messages.length, room.thinking.length]);

  const run = async () => { setSelected(null); const outcome = await room.runRound(); if (outcome) ws.toast(outcome); };
  const send = () => { const text = say.trim(); if (!text) return; setSay(""); void room.say(text); };
  const route = async (id: string, to: "brief" | "boards" | "gen") => {
    const routed = await room.routeSolution(id, to);
    if (!routed) return;
    if (to === "brief") { ws.toast("Added to the Brief."); shell.goSuite("studio", "brief"); }
    else if (to === "boards") { ws.toast("A draft frame is on Boards."); shell.goSuite("studio", "boards"); }
    else {
      /* The solution becomes Gen's prompt, whether Gen is open yet or not. */
      sendGenPreset({ prompt: routed.prompt ?? "" });
      ws.toast("The solution is the prompt in Gen.");
      shell.goGen();
    }
  };

  /* A round header sits above the first message of each round's phase; notes never open one. */
  const rows = room.messages.reduce<{ m: RoomMessage; head: string | null; last: string }[]>((all, m) => {
    const last = all.at(-1)?.last ?? "";
    const next = m.phase === "note" ? last : `Round ${m.round} · ${PHASE_LABEL[m.phase]}`;
    return [...all, { m, head: next !== last ? next : null, last: next }];
  }, []);
  return (
    <div className="cw-room">
      <aside className="cw-col cw-roster" aria-label="In the room" data-testid="crew-roster">
        <div className="gx-panel-head"><span className="gx-panel-title">In the room</span><span className="gx-panel-count">{room.active.length} of {room.members.length}</span></div>
        <div className="cw-members">
          {room.members.map((m) => {
            const thinking = room.running && room.thinking.includes(m.id);
            return (
              <div key={m.id} className="cw-member" data-selected={selected === m.id} data-off={!m.active} data-member={m.name}>
                <button type="button" className="cw-member-main" onClick={() => setSelected(m.id)} aria-label={`${m.name} role card`}>
                  <span className="cw-dot" style={{ background: m.color, opacity: m.active ? 1 : 0.35 }} aria-hidden="true" />
                  <span style={{ minWidth: 0 }}>
                    <span className="cw-member-name">{m.name}</span>
                    <span className="cw-member-dept">{m.department}</span>
                    <span className="cw-member-status" data-thinking={thinking}>{thinking ? "thinking…" : m.isChair ? `chair · ${m.effort} effort` : `${m.effort} effort`}</span>
                  </span>
                </button>
                <button type="button" role="switch" aria-checked={m.active} className="cw-switch" aria-label={`${m.name} speaks next round`} disabled={room.running} onClick={() => void room.patchMember(m.id, { active: !m.active })}><span aria-hidden="true" /></button>
              </div>
            );
          })}
        </div>
        <div className="cw-add">
          <select className="cw-select" aria-label="Add a member" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!project || room.running}>
            <option value="">Add a member…</option>
            {left.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="custom">Custom role…</option>
          </select>
          <button type="button" className="gx-hbtn" disabled={!pick || room.running} onClick={() => { void room.addMember(pick); setPick(""); }}>Add</button>
        </div>
        <p className="cw-foot">Each member is one Grok agent with a role card. Switch a member off to mute them for the next round.</p>
      </aside>

      <section className="cw-col cw-main" aria-label="Room">
        <div className="cw-head">
          <div className="cw-head-text">
            <span className="cw-project"><span className="cw-project-tile" aria-hidden="true">{initials(project?.name ?? "")}</span>{project?.name ?? (projectsError ? "Projects didn’t load" : "No project")}</span>
            <h1 className="gx-h1" data-testid="page-title">{page.title}</h1>
            <span className="gx-hint">{page.hint}</span>
          </div>
          <div className="cw-run">
            {room.blocked ? <span className="gx-reason" id="cw-run-reason" data-testid="crew-run-reason">{room.blocked}</span> : null}
            <button type="button" className="gx-primary" disabled={room.blocked !== null || room.running} aria-describedby={room.blocked ? "cw-run-reason" : undefined} onClick={() => void run()} data-testid="crew-run">
              {room.running ? "Running…" : room.credits == null ? "Run round" : room.usd != null ? `Run round · up to $${room.usd.toFixed(2)}` : `Run round · ${cr(room.credits)}`}
            </button>
          </div>
        </div>

        <div className="cw-goal">
          <div className="cw-goal-top"><label className="gx-eyebrow" htmlFor="cw-goal" data-functional-label="">Goal</label><span className="cw-dim">Rounds run · {room.session?.roundsRun ?? 0} of {ROUNDS_MAX}</span></div>
          <PromptAttach scope={scope} projectId={project?.id} testId="crew-goal-attach" onAttach={async (attached) => {
            const got = await (async (attached: Attached) => { const { media, unreadable } = await resolveAttached(scope, attached); return [...media.map((m) => m.name), ...unreadable]; })(attached);
            if (got.length) room.setGoal(`${room.goal.trim()}\n\nAttached in the project Library: ${got.join(", ")}.`.trim());
            return got.length ? "The room reads words, not pictures or sound: the files are kept in the Library and named in the goal." : null;
          }}><textarea id="cw-goal" className="cw-textarea" rows={3} value={room.goal} disabled={room.running} onChange={(e) => room.setGoal(e.target.value)} placeholder="What should the room solve? One sentence is enough." data-testid="crew-goal" /></PromptAttach>
          <div className="cw-goal-row">
            <span className="cw-dim">Room reads</span>
            {CONTEXT_LABELS.map(([key, label]) => <button key={key} type="button" className="gx-chip" aria-pressed={room.context[key]} disabled={room.running} onClick={() => room.setContext(key)}>{label}</button>)}
            <span className="gx-spacer" />
            <span className="cw-phases" role="group" aria-label="Phase">
              {PHASES.map((ph) => <span key={ph} className="cw-phase" data-on={room.phase?.phase === ph}>{PHASE_LABEL[ph]}</span>)}
            </span>
          </div>
        </div>

        {/* The project list failed to read: said, with Retry — not "No project", which sent people to make duplicates. */}
        {projectsError && !project ? (
          <div className="cw-notice" role="alert" data-testid="crew-projects-error">
            <span className="gx-gen-error">{projectsError}</span>
            {onRetry ? <> <button type="button" className="gx-hbtn" style={{ display: "inline-flex" }} onClick={onRetry}>Retry</button></> : null}
          </div>
        ) : null}
        {room.notice ? <p className="cw-notice" role="status" data-testid="crew-notice">{room.notice}</p> : null}

        <div className="cw-transcript" data-testid="crew-transcript">
          {!room.messages.length && !room.running ? (
            <div className="cw-empty">Write the goal, then run a round. Every member proposes, then challenges one another, then the chair converges the room into solutions.</div>
          ) : null}
          {rows.map(({ m, head }) => (
            <Fragment key={m.id}>
              {head ? <div className="cw-round"><span className="gx-eyebrow" data-functional-label="">{head}</span><span className="cw-rule" aria-hidden="true" /></div> : null}
              <Message m={m} onPin={() => void room.pin(m.id)} />
            </Fragment>
          ))}
          {room.running ? (
            <div className="cw-thinking" role="status" data-testid="crew-thinking"><span className="cw-pulse" aria-hidden="true" />
              {room.thinking.length ? `${room.thinking.map((id) => room.members.find((m) => m.id === id)?.name ?? "Member").join(", ")} ${room.thinking.length === 1 ? "is" : "are"} thinking…` : "Room is thinking…"}
            </div>
          ) : null}
          <div ref={end} />
        </div>

        <div className="cw-say">
          <PromptAttach scope={scope} projectId={project?.id} testId="crew-say-attach" onAttach={async (attached) => {
            const got = await (async (attached: Attached) => { const { media, unreadable } = await resolveAttached(scope, attached); return [...media.map((m) => m.name), ...unreadable]; })(attached);
            if (got.length) setSay((v) => `${v.trim()} (attached in the Library: ${got.join(", ")})`.trim());
            return got.length ? "The room reads words: the files are kept in the Library and named in your message." : null;
          }}><input className="gx-field" aria-label="Interject" placeholder="Say something to the room — members read it next round" value={say} disabled={!project} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} data-testid="crew-say" /></PromptAttach>
          <button type="button" className="gx-hbtn" disabled={!say.trim() || !project} onClick={send}>Send</button>
        </div>
      </section>

      <aside className="cw-col cw-panel" aria-label={member ? "Role card" : "Session"} data-testid="crew-panel">
        {member ? (
          <RoleCard key={member.id} room={room} id={member.id} onBack={() => setSelected(null)} />
        ) : (
          <>
            <span className="gx-eyebrow" data-functional-label="">Session</span>
            <p className="cw-panel-goal">{room.goal.trim() || "No goal yet."}</p>
            <dl className="cw-rows">
              {([["Members", `${room.active.length} seated`], ["Engine", <EngineRow key="engine" room={room} />], ["Rounds", `${room.session?.roundsRun ?? 0} of ${ROUNDS_MAX}`], ["Reads", readsLabel(room.context)], ["Spend", room.session?.spendCr != null ? `${cr(room.session.spendCr)} settled` : room.session && room.session.spendUsd > 0 ? `$${room.session.spendUsd.toFixed(4)} settled` : "Nothing yet"]] as [string, ReactNode][]).map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
            <div className="cw-sol-head"><span className="gx-eyebrow" data-functional-label="">Solutions</span><span className="cw-dim">{room.solutions.length}</span></div>
            {!room.solutions.length ? <span className="cw-dim">The chair writes these when a round converges. Pin any message to add one by hand.</span> : null}
            <div className="cw-solutions" data-testid="crew-solutions">
              {room.solutions.map((s, i) => (
                <div className="cw-solution" key={s.id}>
                  <p><span className="cw-sol-n">{i + 1}</span>{s.text}</p>
                  {s.status !== "open" ? <span className="cw-dim">{s.status === "sent_to_brief" ? "Sent to Brief" : s.status === "boarded" ? "On Boards" : "Opened in Gen"}</span> : null}
                  <div className="cw-sol-actions">
                    <button type="button" className="gx-hbtn" onClick={() => void route(s.id, "brief")}>→ Brief</button>
                    <button type="button" className="gx-hbtn" onClick={() => void route(s.id, "boards")}>Board it</button>
                    <button type="button" className="gx-hbtn cw-go" onClick={() => void route(s.id, "gen")}>Open in Gen</button>
                    <button type="button" className="cw-link" aria-label="Remove solution" onClick={() => void room.dropSolution(s.id)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
            <span className="gx-spacer" />
            {room.session ? <button type="button" className="gx-hbtn cw-wide" onClick={room.newRoom} disabled={room.running}>New session</button> : null}
            <button type="button" className="gx-hbtn cw-wide" disabled={!room.session || !room.messages.length} onClick={() => void room.minutes()}>Export minutes · free</button>
            <button type="button" className="gx-hbtn cw-wide" disabled={!room.session || !room.messages.length || !project || filing} data-testid="crew-file-minutes"
              onClick={() => { if (!project) return; setFiling(true); void room.minutesAsFile().then((file) => uploadToProject(scope, project.id, [file])).then(() => toast("Minutes filed in Assets · byte-identical, this project.")).catch((error: unknown) => toast(error instanceof Error ? error.message : "The minutes could not be filed.")).finally(() => setFiling(false)); }}>
              File minutes in Assets · free
            </button>
          </>
        )}
      </aside>
    </div>
  );
}

function Message({ m, onPin }: { m: RoomMessage; onPin: () => void }) {
  return (
    <div className="cw-msg" data-phase={m.phase} data-to={Boolean(m.to)} data-testid="crew-message">
      <div className="cw-msg-top">
        <span className="cw-dot cw-dot--sm" style={{ background: m.color }} aria-hidden="true" />
        <span className="cw-msg-name">{m.name}</span>
        <span className="cw-dim">{m.department}</span>
        <span className="cw-tag">{PHASE_LABEL[m.phase]}</span>
        <span className="gx-spacer" />
        {m.phase !== "note" ? <button type="button" className="cw-link" title="Pin as a solution" onClick={onPin}>Pin</button> : null}
      </div>
      {m.to ? <span className="cw-dim">↳ to {m.to}</span> : null}
      <p>{m.text}</p>
    </div>
  );
}

function RoleCard({ room, id, onBack }: { room: CrewRoom; id: string; onBack: () => void }) {
  const m = room.members.find((x) => x.id === id)!;
  const [department, setDepartment] = useState(m.department);
  const [stance, setStance] = useState(m.stance);
  const save = (patch: { department?: string; stance?: string }) => { const value = Object.values(patch)[0]?.trim(); if (value) void room.patchMember(m.id, patch); };
  return (
    <>
      <div className="cw-card-top">
        <button type="button" className="cw-back" aria-label="Back to session" onClick={onBack}>‹</button>
        <span className="gx-eyebrow" data-functional-label="">Role card</span>
      </div>
      <div className="cw-card-name"><span className="cw-dot" style={{ background: m.color }} aria-hidden="true" /><span>{m.name}</span></div>
      <label className="cw-label"><span className="gx-eyebrow" data-functional-label="">Role</span>
        <input className="gx-field" value={department} onChange={(e) => setDepartment(e.target.value)} onBlur={() => department !== m.department && save({ department })} />
      </label>
      <label className="cw-label"><span className="gx-eyebrow" data-functional-label="">Stance · system prompt</span>
        <textarea className="cw-textarea" rows={5} value={stance} onChange={(e) => setStance(e.target.value)} onBlur={() => stance !== m.stance && save({ stance })} />
      </label>
      <div className="cw-label"><span className="gx-eyebrow" data-functional-label="">Reasoning effort</span>
        <div className="gx-seg gx-seg--fill" role="radiogroup" aria-label="Reasoning effort">
          {CREW_EFFORTS.map((e) => <button key={e} type="button" role="radio" aria-checked={m.effort === e} className="gx-seg-btn" onClick={() => void room.patchMember(m.id, { effort: e })}><span>{e[0].toUpperCase() + e.slice(1)}</span></button>)}
        </div>
      </div>
      <button type="button" className="gx-hbtn cw-wide" data-on={m.isChair} disabled={m.isChair} onClick={() => void room.patchMember(m.id, { isChair: true })}>{m.isChair ? "Chairs the room — writes the solutions" : "Make chair"}</button>
      <button type="button" className="gx-hbtn cw-wide cw-danger" disabled={room.running} onClick={() => { void room.removeMember(m.id); onBack(); }}>Remove from crew</button>
    </>
  );
}

/* ── Members · Sessions ───────────────────────────────────────────────── */

function PageTop({ title, hint }: { title: string; hint: string }) {
  return <div className="cw-head cw-head--page"><div className="cw-head-text"><h1 className="gx-h1" data-testid="page-title">{title}</h1><span className="gx-hint">{hint}</span></div></div>;
}

function Members({ room, title, hint }: { room: CrewRoom; title: string; hint: string }) {
  const shell = useShell();
  return (
    <div className="cw-page gx-scroll">
      <PageTop title={title} hint={hint} />
      {room.notice ? <p className="cw-notice" role="status">{room.notice}</p> : null}
      <div className="cw-cards">
        {CREW_PRESETS.map((p) => {
          const seated = room.members.some((m) => m.presetId === p.id);
          return (
            <div className="cw-rolecard" key={p.id} data-preset={p.id}>
              <div className="cw-card-name"><span className="cw-dot" style={{ background: p.color }} aria-hidden="true" /><span>{p.name}</span><span className="cw-dim">{p.department}</span></div>
              <p>{p.stance}</p>
              <div className="cw-rolecard-foot"><span className="cw-mono">{room.status?.model || "grok"} · 1 agent</span>
                <button type="button" className="gx-hbtn" disabled={seated} onClick={() => { void room.addMember(p.id); shell.goCrew("room"); }}>{seated ? "In the room" : "Seat in room"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Sessions({ room, title, hint }: { room: CrewRoom; title: string; hint: string }) {
  const shell = useShell();
  return (
    <div className="cw-page gx-scroll">
      <PageTop title={title} hint={hint} />
      {!room.sessions.length ? <p className="cw-empty">{room.loaded ? "No rooms yet. Run a round and it is kept here, with its solutions and what it settled at." : "Loading…"}</p> : null}
      <div className="cw-sessions">
        {room.sessions.map((s) => (
          <button type="button" className="cw-session" key={s.id} onClick={() => { void room.reopen(s.id); shell.goCrew("room"); }}>
            <span style={{ minWidth: 0 }}>
              <span className="cw-session-goal">{s.goal}</span>
              <span className="cw-member-dept">{s.roundsRun} {s.roundsRun === 1 ? "round" : "rounds"} · {s.solutions} {s.solutions === 1 ? "solution" : "solutions"}{s.spendCr != null ? ` · ${cr(s.spendCr)}` : ""}</span>
            </span>
            <span className="cw-mono">{day(s.createdAt)}</span>
            <span className="cw-reopen">Reopen</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export { useCrew };

/* The room's engine. A room keeps the one it was opened on, so a deployment
   that has moved on offers the move here — priced again before any round. */
function EngineRow({ room }: { room: CrewRoom }) {
  const own = room.session?.model ?? room.status?.model ?? "—";
  const current = room.status?.connected ? room.status.model : "";
  if (!room.session || !current || current === room.session.model) return <>{own}</>;
  return (
    <span className="cw-engine-move">
      {own}
      <button type="button" className="gx-hbtn" disabled={room.running} onClick={() => void room.moveToCurrentEngine()} data-testid="crew-engine-move">Move to {current}</button>
    </span>
  );
}
