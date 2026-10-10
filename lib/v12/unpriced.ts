/**
 * Every action in the new interface that has no quote path today, and why (docs/redesign-plan.md, decision 5).
 *
 * Such an action's price reads "quoted". `<Price quote={null} reason="…" />` (components/v12/ui/Price.tsx) only takes a
 * reason from this list, so every unpriced use is visible in code and listed here. When an action gets a quote path, its
 * screen moves to `useQuote` and its entry is removed. The lead copies this list into docs/redesign-progress.md.
 *
 * Sources: docs/redesign/app-map.md § 3.3 (per prototype price) and docs/redesign/inventory.md § 12.
 *
 *  - `action`: the action as the person sees it.
 *  - `why`: why there is no quote path, for the progress log and the owner.
 *  - `hover`: what hovering "quoted" says, in plain words.
 */
export type Unpriced = { action: string; why: string; hover: string };

export const UNPRICED = {
  lipSync: {
    action: "Lip-sync",
    why: "No engine and no quote path: lip-sync lived only on the retired connected-account sign-in path, which now answers 410. The nearest priced route is dubbing (POST /api/audio/dub {quoteOnly}), which is a different action.",
    hover: "Lip-sync has no price yet. It is priced once its engine is connected.",
  },
  makeTurnaround: {
    action: "Make turnaround",
    why: "No code defines a turnaround (only a crew string, lib/workbench/crew.ts). It could be priced as N stills through POST /api/generate/quote once the set of views is defined.",
    hover: "A turnaround has no price yet. It is priced once its views are set.",
  },
  startFromTile: {
    action: "Start from a tile",
    why: "No code defines starting a board from a wall tile. If it means Recreate, quoteRecreate (lib/shell/recreate-price.ts) prices it; otherwise it needs a definition.",
    hover: "Starting from this tile has no price yet.",
  },
  planFix: {
    action: "Fix (from a board plan)",
    why: "A plan fix is drawn from the plan's allowance and priced only when its turn comes (lib/workbench/plan-approval.ts, rig-agent.ts agent.fix); POST /api/rig/runs/[id]/fix carries no price.",
    hover: "This fix is priced when its turn comes in the plan.",
  },
  builtInSkill: {
    action: "A built-in \"/\" skill (Unboxing, Try-on, Tutorial, Photoshoot, Narrated video and the rest of the prototype's list)",
    why: "The prototype's built-in skills (inventory § 10.4) have no definition or quote route yet; each is priced once it is built on an existing quote route (P6). A saved Atomik skill is NOT this: it is priced by POST /api/atomik/skills/[id]/run {dryRun:true}.",
    hover: "This skill has no price yet.",
  },
  hookReview: {
    action: "Hook review",
    why: "No code path reviews a clip's hook (prototype Make viewer and Social clips, inventory § 5.12 and § 10.2): no tool, route or engine exists to quote.",
    hover: "Hook review has no price yet.",
  },
  finishPanel: {
    action: "Finish panel",
    why: "No code path finishes a storyboard panel (clean lines and the final look; inventory § 4.3 card toolbar). Storyboard redraws exist (lib/production/boards.ts) but nothing defines a finish step to quote.",
    hover: "Finishing a panel has no price yet.",
  },
  redrawNoRecord: {
    action: "Redraw a shot whose take has no recorded request (the Rig's \"what a change will cost\")",
    why: "A redraw is priced by quoting the request the take was made with (POST /api/generate/quote, the body Retry sends). A take with no generation record, or one whose request cannot be rebuilt, has no body to quote.",
    hover: "This redraw has no price yet: its take has no recorded request.",
  },
} as const satisfies Record<string, Unpriced>;

export type UnpricedId = keyof typeof UNPRICED;

export const isUnpricedId = (value: unknown): value is UnpricedId =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(UNPRICED, value);
