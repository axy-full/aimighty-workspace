/* The ten Studio stage pages and their Library tool rows are gone (the board is the whole production). */

/** The Rig's Inspector listens for this to switch to a section's tab (components/workspace/rig/RigInspector.tsx). */
export const SECTION_EVENT = "particl:production-section";

/**
 * Where the Library has Tools at all. Make open over a page (`make`) is not a stage; the Business and
 * Viral composers keep every control on the page (their spec cards describe
 * the old bodies, so a row there would lead nowhere); Studio has only Home (the overview and the
 * phone's picker), and the board carries its own Library drawer. There the Library is its Assets.
 */
export function libraryHasTools(view: string, suite: string): boolean {
  if (view === "make" || view === "gen") return false;
  if (suite === "business" || suite === "viral") return false;
  return suite !== "studio";
}

/**
 * A Library row on a spec-card page (the Atomik pages) opens its card
 * on the stage — the card's own button, which brings its tool into the working
 * area. False when the card has no tool (its action is the page's plan).
 */
export function openSpecCard(name: string, root: ParentNode = document): boolean {
  const card = root.querySelector(`.gx-main [data-card="${CSS.escape(name)}"]`);
  if (!card || card.tagName !== "BUTTON") return false;
  (card as HTMLButtonElement).click();
  return true;
}
