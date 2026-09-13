"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSession } from "./session";
import { lockedClaim } from "./usePaidAction";
import type { RefItem } from "./refs";
import type { ShotSpec } from "./studio";

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
  const { workspace, email, signedIn } = useSession();
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
        const variant = batch.variants[index];
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": variant.key,
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
    [enabled, storageKey, workspace, email, recoveryId],
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
