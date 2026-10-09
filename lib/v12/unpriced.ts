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
  skill: {
    action: "A \"/\" skill",
    why: "Skills (prototype § 10.4) have no definition or quote route yet; each is priced once it is built on an existing quote route (P6).",
    hover: "This skill has no price yet.",
  },
} as const satisfies Record<string, Unpriced>;

export type UnpricedId = keyof typeof UNPRICED;

export const isUnpricedId = (value: unknown): value is UnpricedId =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(UNPRICED, value);
