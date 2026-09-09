/**
 * What the command palette can find, as plain data.
 *
 * Deliberately free of React so the ranking can be tested without a browser,
 * and deliberately free of any action that spends: SOW §3 rule 1. Twelve
 * actions in this app call a vendor and write a meter row — Generate, audio,
 * retry, the still post-tools, training an identity, releasing a held take,
 * approving an agent step. A palette is a text field where Return fires the
 * top match, so a mistyped query would sit one keystroke from a customer's
 * credits. Every one of those keeps its own deliberate button with a price on
 * it. What lives here navigates, or does something free and reversible.
 *
 * §10 4.2 asks for "a shot, production, cast member or setting; run an action
 * by name". All four nouns are here. The verbs are the free ones.
 */

import { rank } from "./match";

export type Cmd = {
  id: string;
  label: string;
  group: string;
  /** Right-aligned context: a production name, a shot code, a scope. */
  hint?: string;
  /** Extra things this row can be found by, in falling order of importance. */
  alt?: (string | null | undefined)[];
  href?: string;
  /** A free action the palette host resolves. Never a spending one. */
  act?: "help" | "select";
  arg?: string;
};

export const GROUPS = ["Actions", "Go to", "Productions", "Shots", "Cast", "Takes"] as const;

/* Routes, from the two nav tables that already exist (AppHeader, TabBar).
   Kept as one flat list rather than imported from them because those carry
   icons, match predicates and brand splits the palette does not want. */
export function routeCommands(): Cmd[] {
  const go = (href: string, label: string, hint?: string, alt?: string[]): Cmd =>
    ({ id: `go:${href}`, label, group: "Go to", href, hint, alt });
  return [
    go("/", "Video", "Compose", ["generate"]),
    go("/images", "Images", "Compose", ["stills", "generate"]),
    go("/audio", "Audio", "Compose", ["speech", "sound", "music", "generate"]),
    go("/projects", "Productions", undefined, ["projects"]),
    go("/all", "Everything", undefined, ["library", "all takes"]),
    go("/studio", "Studio", undefined, ["cast", "identities", "setup"]),
    go("/studio/shot", "Shot builder", "Studio", ["shots", "breakdown"]),
    go("/usage", "Usage", undefined, ["spend", "credits", "cost"]),
    go("/settings", "Settings"),
    go("/team", "Team", "Settings", ["members", "invite"]),
    go("/dashboard", "Dashboard"),
    go("/report", "Report"),
    go("/atomik/ideas", "Ideas", "Atomik"),
    go("/atomik/treatment", "Treatment", "Atomik"),
    go("/atomik/breakdown", "Breakdown", "Atomik"),
    go("/atomik/shots", "Shot list", "Atomik"),
    /* The BARE agent route only. `/atomik/agent?c=<id>` re-opens a chat, and
       a chat in auto mode auto-approves its pending step on load — a render,
       with no click (page.tsx's mode==="auto" effect). §3 rule 1. With no
       `?c=` no chat loads, nothing is pending, and nothing can fire. If chats
       ever become palette rows, they must not carry `c`. */
    go("/atomik/agent", "Agent", "Atomik"),
  ];
}

export function actionCommands(): Cmd[] {
  return [
    { id: "act:help", label: "Keyboard shortcuts", group: "Actions", hint: "?", act: "help",
      alt: ["help", "keys", "hotkeys"] },
  ];
}

type P = { id: string; name: string; code?: string; description?: string };
export function productionCommands(projects: P[]): Cmd[] {
  return projects.map((p) => ({
    id: `p:${p.id}`, label: p.name, group: "Productions",
    hint: p.code || undefined, href: `/projects/${p.id}`,
    act: "select" as const, arg: p.id,
    alt: [p.code, p.description],
  }));
}

type S = { id: string; code: string; title: string; projectId?: string | null; scene?: string };
export function shotCommands(shots: S[], projectName?: (id: string | null | undefined) => string | undefined): Cmd[] {
  return shots.map((s) => ({
    id: `s:${s.id}`, label: s.code ? `${s.code} · ${s.title || "Untitled"}` : (s.title || "Untitled"),
    group: "Shots", hint: projectName?.(s.projectId),
    /* Canvas, not /shots/[id]. That route is the Rig bindings screen — five
       slots and nothing else — whereas canvas already reads `?shot=` and
       selects it in the rail, which is the shot in its context: its takes,
       its neighbours, its cap. A shot with no production has no canvas to
       land on, so it falls back to the bindings screen. */
    href: s.projectId ? `/projects/${s.projectId}/canvas?shot=${encodeURIComponent(s.id)}` : `/shots/${s.id}`,
    /* Own code first, then title, then the production — see match.ts's KEY_STEP.
       Being found by your own name has to beat being found by your production's. */
    alt: [s.code, s.title, s.scene, projectName?.(s.projectId)],
  }));
}

type C = { id: string; name: string; kind?: string; description?: string };
export function castCommands(cast: C[]): Cmd[] {
  return cast.map((c) => ({
    id: `c:${c.id}`, label: c.name, group: "Cast", hint: c.kind,
    /* Studio holds its selection in React state; it now seeds that from the
       URL so this link lands ON the member rather than near it. */
    href: `/studio?cast=${encodeURIComponent(c.id)}`,
    alt: [c.name, c.kind, c.description],
  }));
}

type G = { id: string; prompt?: string; shotCode?: string | null; model?: string };
export function takeCommands(gens: G[]): Cmd[] {
  return gens.map((g) => ({
    id: `t:${g.id}`, label: (g.prompt || "Untitled take").replace(/\s+/g, " ").trim().slice(0, 80),
    group: "Takes", hint: g.shotCode || g.model || undefined, href: `/takes/${g.id}`,
    alt: [g.shotCode, g.prompt],
  }));
}

/**
 * Rank everything against one query, then re-group.
 *
 * Groups are ordered by their BEST member, not by the fixed GROUPS order.
 * The first draft did it the other way round — sections always in the same
 * sequence — on the theory that a palette whose sections jump about is
 * unreadable. It is worse than that theory: with Actions pinned first,
 * typing "sh" put "Keyboard shortcuts" above "Shot list", so Return fired
 * the wrong thing. In a palette the top row is a promise about what Return
 * does, and the fixed order broke it. GROUPS still decides ties, so equal
 * scores fall back to the stable sequence, and an empty query — where
 * nothing has a score — keeps it entirely.
 */
export function search(all: Cmd[], query: string, limit = 40): { group: string; items: { cmd: Cmd; at: number[] }[] }[] {
  const q = query.trim();
  const hits = q
    ? rank(all, q, (c) => [c.label, ...(c.alt ?? [])])
        .map((r) => ({ cmd: r.item, at: r.key === 0 ? r.hit.at : [], score: r.hit.score }))
    /* Empty query: the things worth one keystroke, not the whole index. */
    : all.filter((c) => c.group === "Actions" || c.group === "Go to" || c.group === "Productions")
         .map((c) => ({ cmd: c, at: [] as number[], score: 0 }));
  const capped = hits.slice(0, limit);
  return GROUPS
    .map((group, i) => ({ group, i, items: capped.filter((h) => h.cmd.group === group) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => (b.items[0].score - a.items[0].score) || (a.i - b.i))
    .map(({ group, items }) => ({ group, items: items.map(({ cmd, at }) => ({ cmd, at })) }));
}

/** The rows in the order they are drawn — what ↑/↓ and Return walk. */
export function flatten(groups: { items: { cmd: Cmd; at: number[] }[] }[]): Cmd[] {
  return groups.flatMap((g) => g.items.map((i) => i.cmd));
}
