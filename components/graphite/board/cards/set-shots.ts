import type { CardSet } from "./types";
import { groupDef } from "./group/GroupCard";
import { reviewTakeDef, takeDef } from "./take/TakeCard";
import { versionsDef } from "./take/VersionsCard";
import { deriveShots } from "./take/shots-derive";
import { castDef } from "./cast/CastCard";
import { deriveCast } from "./cast/cast-model";
import { cutDef } from "./cut/CutCard";
import { deriveCut } from "./cut/cut-model";
import { deliverDef } from "./deliver/DeliverCard";

/*
 * Stream 5's cards for the board's registry (components/graphite/board/cards/index.ts): the shared group frame,
 * the Shots region's take cards (README § 3.1 f), and frame g's take that waits for you with its versions.
 * The Cast region's character, place and element cards (frame h) draw the canvas's reference cards and the production's
 * own cast and environment lists, and frame i's Cut and Deliver cards (the edit's sequence and the delivery checks).
 */
export const shotCards: CardSet = {
  id: "shots",
  defs: [groupDef, takeDef, reviewTakeDef, versionsDef, castDef, cutDef, deliverDef],
  derive: (src) => [...deriveShots(src), ...deriveCast(src), ...deriveCut(src)],
};
