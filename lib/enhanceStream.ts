import { PaidTextError } from "./paidText";

/**
 * The enhancer's answer, word by word (the owner, 16 Oct 2026): one JSON line per word, `{"t":"word "}`, paced to finish inside about a second, then the
 * settlement, then `{"done":true,"prompt","provider","writer"}`. The workspace is charged only once the last word is out (`finish`). A reader that goes away
 * while the words are still going out (Cancel, a dropped connection: the stream is cancelled, or the request's own signal ends) abandons the answer: failed
 * at zero, never charged, and the claim replays that. The claim is ended here, not from the body (lib/generationRequests.ts CLAIM_DEFERRED_HEADER).
 *
 * The three phases never overlap, so the claim always says what the job became:
 *  - words: a reader leaving abandons (free); `finish` is never called;
 *  - settling (`finish` is running): a reader leaving changes nothing; the job ends as `finish` ends it and the claim replays that answer, so the same press
 *    collects the words it paid for, once;
 *  - over: nothing more happens.
 * A `finish` that fails with a paid-text refusal (answered after the cron's pass returned the hold) is said as nothing billed; any other failure says only that
 * the answer couldn't be delivered, never a claim about the bill it cannot back.
 */
export type EnhanceAnswer = { prompt: string; provider: string; writer: string };
export function enhanceStream(o: {
  answer: EnhanceAnswer;
  finish: () => Promise<unknown>;
  abandon: (why: string) => Promise<unknown>;
  /** Ends the press's claim with the answer its key replays. */
  complete: (status: number, json: string) => Promise<void>;
  /** The request's own signal: it ending while words go out is a reader gone. */
  signal?: AbortSignal;
  /** The pause between words (tests set 0). */
  gapMs?: number;
}): ReadableStream<Uint8Array> {
  const words = o.answer.prompt.match(/\S+\s*/g) ?? [o.answer.prompt];
  const gap = o.gapMs ?? Math.max(6, Math.min(40, Math.floor(1_200 / words.length)));
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  let phase: "words" | "settling" | "over" = "words";
  const complete = (status: number, body: unknown) => o.complete(status, JSON.stringify(body)).catch(() => {});
  /* The reader left while the words were still going out: free. */
  const left = async () => {
    if (phase !== "words") return;
    phase = "over";
    await o.abandon("The stream was cut off before the last word.").catch(() => {});
    await complete(499, { error: "Cancelled. Nothing billed.", nothingBilled: true });
  };
  const onAbort = () => { void left(); };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) onAbort();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => { try { controller.enqueue(line(value)); return true; } catch { return false; } };
      try {
        for (const word of words) {
          if (phase !== "words") return;
          if (!send({ t: word })) { await left(); return; }
          await new Promise((resolve) => setTimeout(resolve, gap));
        }
        if (phase !== "words") return;
        phase = "settling";
        try {
          await o.finish();
        } catch (error) {
          phase = "over";
          const said = error instanceof PaidTextError ? { error: error.message, nothingBilled: true } : { error: "The answer couldn't be delivered." };
          await complete(502, said);
          if (send(said)) controller.close();
          return;
        }
        phase = "over";
        await complete(200, o.answer);
        if (send({ done: true, ...o.answer })) controller.close();
      } finally {
        o.signal?.removeEventListener("abort", onAbort);
      }
    },
    async cancel() { await left(); },
  });
}
