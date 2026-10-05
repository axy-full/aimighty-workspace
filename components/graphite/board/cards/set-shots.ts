import type { CardSet } from "./types";
import { groupDef } from "./group/GroupCard";
import { reviewTakeDef, takeDef } from "./take/TakeCard";
import { versionsDef } from "./take/VersionsCard";
import { deriveShots } from "./take/shots-derive";

/*
 * Stream 5's cards for the board's registry (components/graphite/board/cards/index.ts): the shared group frame,
 * the Shots region's take cards (README § 3.1 f), and frame g's take that waits for you with its versions.
 * The Cast, Cut and Deliver cards join this set in their own PRs.
 */
export const shotCards: CardSet = {
  id: "shots",
  defs: [groupDef, takeDef, reviewTakeDef, versionsDef],
  derive: deriveShots,
};
