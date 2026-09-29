"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSession } from "./session";
import { lockedClaim } from "./usePaidAction";
import { settleStoredRequest } from "./workspace/generate-submit";
import type { RefItem } from "./refs";
import type { ShotSpec } from "./studio";
import { creditsFigure } from "./creditTerms";

type Refusal = { message: string; needsReason: boolean; line?: string };
export type GenerationBatch = {
  id: string;
  cursor: number;
  variants: { key: string; body: string; resultId?: string }[];
  refusal?: Refusal;
  display: {
    prompt: string;
    modelId: string;
    ratio: string;
    resolution: string;
    seconds: number;
    count: number;
    audio: boolean;
    refs: RefItem[];
    useAs: "loose" | "first";
    spec: ShotSpec;
    price: number;
    unit: "cr" | "usd";
  };
};
const eventName = "particl-generation-batch-storage";
const notify = () => window.dispatchEvent(new Event(eventName));
const subscribe = (listener: () => void) => {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
};
const serverSnapshot = () => "{}";
const unreadable =
  "The saved batch cannot be read. Check Activity before starting another batch.";

function read(key: string): GenerationBatch | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const batch = JSON.parse(raw) as GenerationBatch;
  if (
    !batch ||
    typeof batch.id !== "string" ||
    !batch.id ||
    !Array.isArray(batch.variants) ||
    batch.variants.length < 1 ||
    batch.variants.length > 8 ||
    !Number.isInteger(batch.cursor) ||
    batch.cursor < 0 ||
    batch.cursor > batch.variants.length ||
    !batch.display ||
    typeof batch.display.prompt !== "string" ||
    typeof batch.display.modelId !== "string" ||
    typeof batch.display.ratio !== "string" ||
    typeof batch.display.resolution !== "string" ||
    !Number.isFinite(batch.display.seconds) ||
    batch.display.count !== batch.variants.length ||
    !Number.isFinite(batch.display.price) ||
    batch.display.price < 0 ||
    !["cr", "usd"].includes(batch.display.unit) ||
    !Array.isArray(batch.display.refs) ||
    !batch.display.spec
  )
    throw new Error(unreadable);
  batch.variants.forEach((variant, i) => {
    if (
      !variant ||
      typeof variant.key !== "string" ||
      !variant.key ||
      typeof variant.body !== "string" ||
      (i < batch.cursor &&
        (typeof variant.resultId !== "string" || !variant.resultId))
    )
      throw new Error(unreadable);
    const body = JSON.parse(variant.body);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.prompt !== "string"
    )
      throw new Error(unreadable);
  });
  return batch;
}
function write(key: string, batch: GenerationBatch) {
  const raw = JSON.stringify(batch);
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new Error(unreadable);
  notify();
}

/** Persist every authorized variant before the first POST and advance only after an accepted job. */
export function useGenerationBatch(surface: string, active: boolean) {
  const { workspace, email, signedIn, requestScope } = useSession();
  const enabled = !!(active && signedIn && workspace?.id && email);
  const storageKey = `particl:generation-batch:${JSON.stringify([workspace?.id, email, surface])}`;
  const current = useRef({ storageKey, enabled });
  useEffect(() => {
    current.current = { storageKey, enabled };
    return () => {
      current.current.enabled = false;
    };
  }, [storageKey, enabled]);
  const snapshot = useCallback(() => {
    if (!enabled) return "{}";
    try {
      return JSON.stringify({ pending: read(storageKey) });
    } catch {
      return JSON.stringify({ error: unreadable });
    }
  }, [enabled, storageKey]);
  const state = JSON.parse(
    useSyncExternalStore(subscribe, snapshot, serverSnapshot),
  ) as { pending?: GenerationBatch; error?: string };
  const recoveryId = state.pending?.id;
  const run = useCallback(
    async (
      proposed: GenerationBatch,
      options: {
        review: (refusal: Refusal) => Promise<string | null | undefined>;
        notices: (notices: string[]) => void;
      },
    ) => {
      const guard = () => {
        if (
          !enabled ||
          !current.current.enabled ||
          current.current.storageKey !== storageKey
        )
          throw new Error(
            "Recover this batch in its original account and workspace.",
          );
      };
      guard();
      /* A batch saved before this press may have sent its pending take already, its reply lost: that take is
         asked about by its key before anything else goes (settleStoredRequest). A take refused for good goes
         again only under a new key, re-quoted first. Either way nothing goes above the price the batch showed. */
      const recovering = Boolean(recoveryId && recoveryId === proposed.id);
      let settle: "ask" | "quote" | null = recovering ? "ask" : null;
      let batch = await lockedClaim(storageKey, () => {
        guard();
        const saved = read(storageKey);
        if (recoveryId && (!saved || saved.id !== recoveryId))
          throw new Error(
            "This batch has already been recovered. Refresh before starting another.",
          );
        if (saved && saved.id !== proposed.id)
          throw new Error("Recover the saved batch before starting another.");
        const claimed = saved ?? proposed;
        write(storageKey, claimed);
        return claimed;
      });
      if (batch.refusal) {
        const reason = await options.review(batch.refusal);
        if (reason === null) return false;
        guard();
        batch = await lockedClaim(storageKey, () => {
          const saved = read(storageKey);
          if (!saved || saved.id !== batch.id)
            throw new Error("The batch has already been recovered.");
          if (saved.refusal) {
            // A confirmed pre-job refusal can retry only this remaining variant on a new explicit press.
            const variant = saved.variants[saved.cursor];
            variant.key = crypto.randomUUID();
            if (reason)
              variant.body = JSON.stringify({
                ...JSON.parse(variant.body),
                reason,
              });
            delete saved.refusal;
            write(storageKey, saved);
          }
          return saved;
        });
        settle = "quote";
      }
      while (true) {
        guard();
        const saved = read(storageKey);
        if (!saved || saved.id !== batch.id)
          throw new Error("The batch has already been recovered.");
        batch = saved;
        if (batch.refusal) throw new Error(batch.refusal.message);
        if (batch.cursor === batch.variants.length) return true;
        const index = batch.cursor;
        let variant = batch.variants[index];
        if (settle) {
          const how = settle;
          settle = null;
          const approved = { price: batch.display.price / batch.display.count, unit: batch.display.unit };
          const outcome = await settleStoredRequest({ scope: requestScope ?? "", key: variant.key, endpoint: "/api/generate", body: variant.body, approved, ask: how === "ask" });
          guard();
          if (outcome.state === "unknown") throw new Error(outcome.reason);
          if (outcome.state === "landed") {
            /* It reached the server: that take is followed, and the batch goes on from the next one. */
            await lockedClaim(storageKey, () => {
              const latest = read(storageKey);
              if (latest?.id === batch.id && latest.cursor === index && latest.variants[index].key === variant.key) {
                latest.variants[index].resultId = outcome.jobId;
                latest.cursor++;
                write(storageKey, latest);
              }
            });
            if (outcome.status === "failed") options.notices(["A submitted take failed. Check Activity for its result."]);
            continue;
          }
          if (outcome.state === "repriced") {
            /* Never made, and priced differently now: nothing more goes from this batch. What it made stays. */
            await lockedClaim(storageKey, () => {
              const latest = read(storageKey);
              if (latest?.id === batch.id && latest.cursor === index) {
                localStorage.removeItem(storageKey);
                notify();
              }
            });
            const each = (n: number) => (batch.display.unit === "usd" ? `$${n.toFixed(2)}` : `${creditsFigure(n)} cr`);
            throw new Error(`The estimate is now about ${each(outcome.price)} a take; this batch was approved at about ${each(approved.price)}. Its remaining takes were not sent, and nothing was charged for them.`);
          }
          if (how === "ask") {
            /* Set aside there, never made: it goes again under a new key, at the price the batch showed. */
            variant = await lockedClaim(storageKey, () => {
              const latest = read(storageKey);
              if (!latest || latest.id !== batch.id || latest.cursor !== index || latest.variants[index].key !== variant.key)
                throw new Error("The batch has already been recovered.");
              latest.variants[index].key = crypto.randomUUID();
              write(storageKey, latest);
              return latest.variants[index];
            });
          }
        }
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": variant.key,
            "X-Workbench-Scope": requestScope ?? "",
            "X-Workspace-Id": workspace!.id,
            "X-Actor-Email": email!,
          },
          body: variant.body,
        });
        const data = await response.json().catch(() => null);
        guard();
        if (typeof data?.id !== "string" || !data.id) {
          const message =
            data?.error ||
            "The submission could not be confirmed. Recover the batch to check the same take.";
          if (
            [400, 401, 402, 403, 404, 409, 413, 422, 429].includes(
              response.status,
            ) &&
            response.headers.get("Idempotency-Status") === "complete"
          ) {
            await lockedClaim(storageKey, () => {
              const latest = read(storageKey);
              if (
                latest?.id === batch.id &&
                latest.cursor === index &&
                latest.variants[index].key === variant.key
              ) {
                latest.refusal = {
                  message,
                  needsReason: !!data?.needsReason,
                  line: data?.line,
                };
                write(storageKey, latest);
              }
            });
          }
          throw new Error(message);
        }
        await lockedClaim(storageKey, () => {
          const latest = read(storageKey);
          if (
            latest?.id === batch.id &&
            latest.cursor === index &&
            latest.variants[index].key === variant.key
          ) {
            latest.variants[index].resultId = data.id;
            latest.cursor++;
            write(storageKey, latest);
          }
        });
        // A known failed job may have incurred provider cost. It is an attempted take, never a fresh retry.
        if (!response.ok)
          options.notices([
            data.error ||
              "A submitted take failed. Check Activity for its result.",
          ]);
        if (Array.isArray(data.notices) && data.notices.length)
          options.notices(data.notices);
      }
    },
    [enabled, storageKey, workspace, email, recoveryId, requestScope],
  );
  const complete = useCallback(
    (id: string) =>
      lockedClaim(storageKey, () => {
        const saved = read(storageKey);
        if (saved?.id === id && saved.cursor === saved.variants.length) {
          localStorage.removeItem(storageKey);
          notify();
        }
      }),
    [storageKey],
  );
  return {
    pending: state.pending ?? null,
    error: state.error ?? null,
    run,
    complete,
  };
}
