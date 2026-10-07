import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { sampleWorkspaceAnswer } from "../../lib/demo/sample";

/**
 * The sample workspace offers no priced control (the review's M1) and the client's read fails closed (L5).
 * The browser proof is tests/sample-paid-controls-workbench.spec.ts; this holds the two pure halves: what a read means,
 * and that every surface the review named is still wired to the one hook (or, on a board, to the board's gate, which is
 * that hook's answer), so a refactor cannot quietly bring a priced control back.
 */

test("the read fails closed: only a clear answer without the flag offers priced controls; a failed one is unknown (still closed), not the sample", () => {
  expect(sampleWorkspaceAnswer(null)).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: false, body: { sampleWorkspace: false } })).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: true, body: "<html>" })).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: true, body: { board: null, sampleWorkspace: true } })).toBe("sample");
  expect(sampleWorkspaceAnswer({ ok: true, body: { board: null } })).toBe("normal");
  /* The hook hands every screen a line for "sample" and for "unknown" (so they hide priced controls), and null only for "normal". The truth table and the retry: tests/unit/sample-check.spec.ts. */
  expect(readFileSync("lib/demo/use-sample.ts", "utf8")).toMatch(/state === "sample" \? SAMPLE_LINE : state === "unknown" \? CHECK_LINE : null/);
});

/** Each named surface: the file, and what must be in it for the sample (hook or the board's own gate), then the priced control it guards. */
const SURFACES: { name: string; file: string; guard: RegExp; control: RegExp }[] = [
  { name: "⌘K's Ask Atomik card: no priced Ask", file: "components/graphite/atomik/panel/PaletteCards.tsx", guard: /useSampleWorkspace\(\)/, control: /spendOff && intent\.kind === "ask" \? null/ },
  { name: "⌘K's Approve under N cr card: no list, total or confirm", file: "components/graphite/atomik/panel/PaletteApprove.tsx", guard: /useSampleWorkspace\(\)/, control: /if \(spendOff\) return \(/ },
  { name: "DraftFinalBar: not drawn (no quote, no Make the 1080p final)", file: "components/graphite/DraftFinal.tsx", guard: /useSampleWorkspace\(\)/, control: /spendOff \? null : <PricedDraftFinalBar/ },
  { name: "Inspector: no Draft eyebrow over a bar that is not drawn", file: "components/graphite/AssetInspector.tsx", guard: /useSampleWorkspace\(\)/, control: /pair\?\.draft && generation && !spendOff/ },
  { name: "Inspector: no priced Recreate", file: "components/graphite/AssetInspector.tsx", guard: /useSampleWorkspace\(\)/, control: /\{spendOff \? null : <button type="button" className="gx-primary"/ },
  { name: "ReleaseTake: not drawn for a held take", file: "components/graphite/ReleaseTake.tsx", guard: /useSampleWorkspace\(\)/, control: /if \(spendOff \|\| !generation/ },
  { name: "Control room ThreadCheckpoint: no checkpoint, no Continue", file: "components/graphite/control-room/ThreadCheckpoint.tsx", guard: /useSampleWorkspace\(\)/, control: /if \(spendOff\) return null/ },
  { name: "Control room BatchApprove: not drawn", file: "components/graphite/control-room/BatchApprove.tsx", guard: /useSampleWorkspace\(\)/, control: /if \(spendOff\) return null/ },
  { name: "Next row: no priced actions (so no NextActionPanel)", file: "components/graphite/AssetNextActions.tsx", guard: /useSampleWorkspace\(\)/, control: /scope && project && !spendOff \? pricedActions/ },
  { name: "Approvals queue: every item reads as the sample's (no Approve anywhere it is drawn)", file: "lib/control-room/use-approvals.ts", guard: /useSampleWorkspace\(\)/, control: /spendOff \? \(current\.reply\?\.items \?\? \[\]\)\.map/ },
  { name: "Phone Home rows: a sample item has no priced button", file: "components/graphite/phone/HomeScreen.tsx", guard: /item\.sample/, control: /else if \(item\.sample\) action = item\.unchecked \? <CheckAgain className="ph-btn" \/> : null/ },
  { name: "Viral tool: no run button", file: "components/graphite/viral/ViralView.tsx", guard: /useSampleWorkspace\(\)/, control: /\{spendOff \? null : <button type="button" className="gx-primary gx-gen-go"/ },
  { name: "3D blocking strip: no priced Remake", file: "components/graphite/board/blocking/ShotBlockingStrip.tsx", guard: /ctx\.exploreOnly/, control: /\{ctx\.exploreOnly \? null : <button type="button" className="gx-bk-btn" title=\{title/ },
  { name: "3D blocking overlay: no Prop from a photo", file: "components/graphite/board/blocking/BlockingOverlay.tsx", guard: /ctx\.exploreOnly/, control: /\{ctx\.exploreOnly \? null : <button[^>]*data-testid="blocking-add-photo"/ },
  { name: "Ads image-ad card: no Make", file: "components/graphite/board/ads/cards/AdCards.tsx", guard: /exploreOnly/, control: /\{spendOff \? null : <Actions>/ },
  { name: "Edit & Sound: no New voice line, music or effect", file: "components/graphite/board/edit/EditSoundScreen.tsx", guard: /ctx\.exploreOnly/, control: /\{ctx\.exploreOnly \? null : <div className="gx-es-stack">/ },
];

for (const { name, file, guard, control } of SURFACES) {
  test(`${name} (${file.split("/").pop()})`, () => {
    const source = readFileSync(file, "utf8");
    expect(source, "the sample check").toMatch(guard);
    expect(source, "the guarded control").toMatch(control);
    if (file.endsWith("ShotBlockingStrip.tsx")) expect(source.match(/data-testid="blocking-remake"/g)?.length, "one Remake button, so the guard covers all of them").toBe(1);
  });
}

test("the board's gate is the hook's answer, so the board-level surfaces fail closed too", () => {
  const source = readFileSync("components/graphite/board/BoardView.tsx", "utf8");
  expect(source).toMatch(/const spendOff = useSampleWorkspace\(\)/);
  /* Save where the viewer lifted the mark for one run (lib/demo/lift.server.ts): only their own lift opens it, never on a sample copy. */
  expect(source).toMatch(/exploreOnly: liftedHere \? null : onSample\.exploreOnly \?\? spendOff/);
  expect(source).toMatch(/const liftedHere = !!lift\?\.mine && !!project && !isSampleDraftId\(project\.id\)/);
});
