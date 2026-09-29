"use client";
import { useRig } from "./RigProvider";

/** What the server's change was, as the team is told it just happened (no live room). */
const DONE: Record<string, string> = { tidy: "tidied the board", reassert: "kept the team's cards on the board", ops: "changed the board", import: "brought an old board across" };
const ATOMIK_COLOR = "#e0b95e";

/** Who else is on this production's canvas, above the shot list and the graph alike — Atomik too, while it works on the board. */
export function TeamPresence() {
  const { team, project } = useRig();
  if (!project || team.mode === "off") return null;
  const people = team.peers.filter((p) => !p.agent);
  const agent = team.peers.find((p) => p.agent);
  /* Live: Atomik is in the room while it works. No room: the server change this window just folded in. */
  const atomik = agent
    ? { doing: (agent.doing ?? "Working on the board").replace(/^./, (c) => c.toLowerCase()), color: agent.color }
    : team.server ? { doing: DONE[team.server.what] ?? DONE.ops, color: ATOMIK_COLOR } : null;
  const chip = atomik ? (
    <span className="pxw-team-peer" data-testid="rig-team-agent"><i style={{ background: atomik.color, color: "#1c1c1e" }}>A</i>Atomik · {atomik.doing}</span>
  ) : null;
  if (team.mode === "saved")
    return (
      <p className="pxw-team" data-mode="saved" data-testid="rig-team">
        <span className="pxw-team-dot" aria-hidden="true" />
        Team canvas · every shot and node here is shared with your team
        {chip}
      </p>
    );
  const count = people.length;
  return (
    <p className="pxw-team" data-mode="live" data-testid="rig-team" role="status">
      <span className="pxw-team-dot" aria-hidden="true" />
      {count ? `Live · ${count} ${count === 1 ? "teammate" : "teammates"} here` : "Live · edits reach your team as you make them"}
      {people.slice(0, 6).map((p) => (
        <span key={p.id} className="pxw-team-peer"><i style={{ background: p.color }}>{p.name.slice(0, 1).toUpperCase()}</i>{p.name}</span>
      ))}
      {count > 6 ? <span>+{count - 6}</span> : null}
      {chip}
    </p>
  );
}
