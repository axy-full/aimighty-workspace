"use client";

import { useApi } from "@/lib/useApi";
import { timeAgo } from "@/lib/format";
import type { SharedKeyDesk } from "@/lib/sharedKeyDesk";

/**
 * The platform owner's desk: the shared provider key (lib/sharedKeyDesk.ts).
 * How full its pool is and who waits in its line, the takes waiting on a key
 * that changed (with what to do about it), and the latest requests with the
 * request_id and correlation id the provider's support asks for. Only the
 * platform owner can read the route behind it; no member ever sees these ids.
 */
export function SharedKeyCard() {
  const { data, error, refresh } = useApi<SharedKeyDesk>("/api/admin/shared-key", 30_000);
  const keyWord = (r: SharedKeyDesk["requests"][number]) =>
    r.key === "platform" ? "platform key" : r.key === "previous" ? `previous platform key ${r.keyPrefix}…` : `key ${r.keyPrefix}…`;
  return (
    <section className="scard" data-testid="shared-key-card">
      <div className="scard-h">
        <span>Shared provider key</span>
        <span>Every workspace on the platform&rsquo;s key shares one provider account. Its pool keeps requests under the provider&rsquo;s limit: a take past it waits as Queued and starts, once, when a slot frees.</span>
      </div>
      {!data && error ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="shared-key-fault">
          <span className="rail-help">The shared key&rsquo;s state could not be read.</span>
          <button type="button" className="btn-secondary min-h-[44px]" onClick={() => void refresh()}>Try again</button>
        </div>
      ) : !data ? (
        <span className="rail-help">Reading the shared key…</span>
      ) : (
        <>
          <div className="flex flex-col gap-1.5" data-testid="shared-key-pool">
            <span className="font-medium">
              {data.pool.on
                ? `${data.pool.inFlight} of ${data.pool.size} slots in flight · ${data.pool.waiting} queued · each workspace up to ${data.pool.share}`
                : "The pool is off (HF_POOL_SIZE): nothing waits for the shared key."}
            </span>
            {data.pool.workspaces.map((w) => (
              <span key={w.id} className="rail-help break-words">{w.name}: {w.inFlight} in flight · {w.waiting} queued</span>
            ))}
          </div>

          <div className="flex flex-col gap-1.5" data-testid="shared-key-changes">
            <p className="grouplabel !pb-0">Waiting on a key that changed</p>
            {data.keyChanges.length === 0 ? (
              <span className="rail-help">None. Every request is collected with the key it was sent on.</span>
            ) : (
              <>
                {data.keyChanges.map((k) => (
                  <span key={k.take} className="rail-help break-all">{k.workspace} · take {k.take} · key {k.key}… · since {timeAgo(k.since)}</span>
                ))}
                <span className="rail-help">Nothing was failed or sent again. Keep the old key under HF_CREDENTIALS_PREVIOUS, or, if it belonged to the same provider organization, add its fingerprint to HF_CREDENTIAL_ALIASES.</span>
              </>
            )}
          </div>

          <div className="flex flex-col" data-testid="shared-key-requests">
            <p className="grouplabel !pb-0">Latest requests</p>
            {data.requests.length === 0 ? <span className="rail-help pt-1">No request yet.</span> : data.requests.map((r) => (
              <div key={r.take} className="flex flex-col gap-1 border-b border-[var(--color-hair)] py-2.5" data-testid="shared-key-request">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium break-words">{r.workspace}</span>
                  <span className="mono-s break-all">{r.model}</span>
                  <span className="mono-s">{timeAgo(r.at)}</span>
                  <span className="mono-s">{r.settled ? "SETTLED" : "OPEN"}</span>
                </span>
                <span className="mono-s !leading-[1.45] break-all">REQUEST <span className="text-ink" data-testid="shared-key-request-id">{r.requestId}</span></span>
                <span className="mono-s !leading-[1.45] break-all">CORRELATION <span className="text-ink" data-testid="shared-key-correlation-id">{r.correlationId ?? "—"}</span></span>
                <span className="mono-s !leading-[1.45] break-all">{keyWord(r)} · take {r.take}</span>
              </div>
            ))}
            <span className="rail-help pt-2">
              {data.correlationSent
                ? "Our correlation id goes out with every request on the key; the provider’s own is kept when it answers with one. Give support both ids."
                : "Ours is switched off (HF_CORRELATION_HEADER); the provider’s own correlation id is kept when it answers with one."}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
