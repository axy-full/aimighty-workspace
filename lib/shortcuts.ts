/**
 * Every keyboard shortcut in the product, as data.
 *
 * SOW §11 5.1 says the Mac app's native menus carry every shortcut from
 * §10 4.2. A menu can only carry what it can enumerate, so the binding table
 * has to be a list something else can read — not a `keydown` handler buried
 * in whichever component happens to own the key today. That is the whole
 * reason this file is data and not code.
 *
 * `live` is the honest part, and it is why the `?` overlay is trustworthy.
 * §10 4.2 lists a set to BUILD; most of it does not exist yet. An overlay
 * that showed `⌘0 fit graph` while ⌘0 did nothing would be worse than no
 * overlay — the reader would try it, nothing would happen, and they would
 * stop believing the rest of the list. So the overlay renders `live` rows
 * only, and the planned rows stay here, enumerable, as the table 5.1 needs
 * and the list of what is left to wire.
 *
 * `owner` records who actually handles a live key. Only `"global"` rows are
 * handled by the layer in CommandPalette.tsx; the rest were implemented as
 * ad-hoc listeners long before this file existed, and this is the index of
 * where they live.
 */

export type Scope = "global" | "review" | "compose" | "rig";

export type Shortcut = {
  id: string;
  /** Display form, already in Mac notation. Space-separated keys render as separate chips. */
  keys: string;
  label: string;
  scope: Scope;
  /** Does pressing this do something today? Only live rows reach the overlay. */
  live: boolean;
  /** "global" = the app-wide layer. Otherwise where the handler lives. */
  owner: string;
};

export const SCOPE_LABEL: Record<Scope, string> = {
  global: "Anywhere",
  review: "Watching",
  compose: "Composing",
  rig: "Rig",
};

export const SHORTCUTS: Shortcut[] = [
  { id: "palette",   keys: "⌘K",   label: "Command palette",       scope: "global",  live: true,  owner: "global" },
  { id: "search",    keys: "/",    label: "Search — same palette", scope: "global",  live: true,  owner: "global" },
  { id: "help",      keys: "?",    label: "This list",             scope: "global",  live: true,  owner: "global" },
  { id: "esc",       keys: "esc",  label: "Close what is open",    scope: "global",  live: true,  owner: "dialog, sheets, Theatre" },

  /* All four arrows now do their §4.2 job: ←/→ step a frame, ↑/↓ walk the
     takes. Both rows are live because both keys actually move something —
     the note that used to sit here, explaining that ←/→ stepped takes
     instead of frames, describes a product that no longer exists. */
  { id: "taketake",  keys: "↑ ↓",  label: "Between takes",         scope: "review",  live: true,  owner: "Theatre" },
  { id: "framestep", keys: "← →",  label: "Step one frame",        scope: "review",  live: true,  owner: "Theatre" },
  { id: "playpause", keys: "space",label: "Play or pause",         scope: "review",  live: true,  owner: "Compare" },

  { id: "generate",  keys: "⌘↵",   label: "Generate",              scope: "compose", live: true,  owner: "Composer, audio, IdentitySheet" },

  /* Planned — §10 4.2's set, not yet wired. Enumerable for the Mac menu work
     and for whoever picks these up; deliberately absent from the overlay. */
  { id: "shuttle",   keys: "J K L",label: "Shuttle back / stop / forward", scope: "review", live: false, owner: "—" },
  { id: "shotshot",  keys: "[ ]",  label: "Between shots",         scope: "review",  live: false, owner: "—" },
  { id: "pick",      keys: "P",    label: "Pick",                  scope: "review",  live: false, owner: "—" },
  { id: "approve",   keys: "A",    label: "Approve",               scope: "review",  live: false, owner: "—" },
  { id: "sendback",  keys: "S",    label: "Send back with a note", scope: "review",  live: false, owner: "—" },
  { id: "batch",     keys: "⌘⇧↵",  label: "Generate a batch",      scope: "compose", live: false, owner: "—" },
  { id: "rail",      keys: "⌘\\",  label: "Toggle the rail",       scope: "compose", live: false, owner: "—" },
  { id: "rig1",      keys: "⌘1 ⌘2 ⌘3", label: "Assets / Stages / Runs", scope: "rig", live: false, owner: "—" },
  { id: "rigpan",    keys: "space",label: "Pan the graph",         scope: "rig",     live: false, owner: "—" },
  { id: "rigfit",    keys: "⌘0",   label: "Fit the graph",         scope: "rig",     live: false, owner: "—" },
  { id: "rigfind",   keys: "⌘F",   label: "Find a node",           scope: "rig",     live: false, owner: "—" },
];

/** What the `?` overlay shows: what actually works, grouped. */
export function byScope(): { scope: Scope; items: Shortcut[] }[] {
  const order: Scope[] = ["global", "compose", "review", "rig"];
  return order
    .map((scope) => ({ scope, items: SHORTCUTS.filter((s) => s.scope === scope && s.live) }))
    .filter((g) => g.items.length > 0);
}

/** Still to wire — §10 4.2's remainder. Not shown to anyone; read by us. */
export const PLANNED = SHORTCUTS.filter((s) => !s.live);
