/**
 * A crew round sent from this browser whose answer has not come back yet.
 *
 * The rounds route files no job and binds no Idempotency-Key, so POST
 * /api/generate/check cannot answer for it. Its key is the round number
 * instead: the route runs round N only while N - 1 rounds have run
 * (lib/crew/store.ts › claimRound), and the room itself says what became of
 * it. So a press after a lost reply first reads the room, and sends nothing
 * until that round is known.
 */
export type PendingRound = { sessionId: string; round: number; credits: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export const pendingRoundKey = (scope: string, sessionId: string) => `particl:pending-crew-round:${JSON.stringify([scope, sessionId])}`;

export function readPendingRound(storage: Storage, key: string): PendingRound | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<PendingRound> | null;
  if (!value || typeof value.sessionId !== "string" || !Number.isInteger(value.round) || value.round! < 1 || !Number.isFinite(value.credits)) return null;
  return { sessionId: value.sessionId, round: value.round!, credits: value.credits! };
}

export function writePendingRound(storage: Storage, key: string, pending: PendingRound): void {
  storage.setItem(key, JSON.stringify(pending));
}

export function clearPendingRound(storage: Storage, key: string, round: number): void {
  if (readPendingRound(storage, key)?.round === round) storage.removeItem(key);
}

/**
 * What became of a round sent earlier, from the room as it reads now: it ran
 * (and was billed: only a billed round advances the count), it is running, or
 * it has not run (never arrived, or stopped unbilled), which is the only case
 * in which the next round may go.
 */
export function roundFate(pending: Pick<PendingRound, "round">, session: { roundsRun: number; running?: boolean }): "ran" | "running" | "not-run" {
  if (session.roundsRun >= pending.round) return "ran";
  if (session.running) return "running";
  return "not-run";
}
