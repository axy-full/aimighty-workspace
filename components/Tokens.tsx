"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { usd, timeAgo } from "@/lib/format";
import { appAlert, appConfirm, appPrompt } from "./dialog";
import { parseCeiling, parseCreditCeiling } from "@/lib/tokenCeiling";

/** GET /api/tokens answers in the workspace's unit: credits (no dollar field at all) or dollars. */
export type Token = {
  id: string; name: string; scope: "read" | "render";
  capUsd?: number | null; spendThisMonth?: number;
  capCredits?: number | null; spendCredits?: number; legacyCeiling?: boolean;
  lastUsed: number | null; createdAt: number;
};
type Unit = "credits" | "usd";
const cr = (n: number) => `${Math.round(n).toLocaleString("en-US")} cr`;

/**
 * Making and revoking the keys that let something outside a browser in.
 * The secret is shown exactly once — after that only its hash exists.
 */
export default function Tokens({ onNewToken }: { onNewToken?: (t: string) => void }) {
  const scopedFetch = useScopedFetch();
  const { data, refresh } = useApi<{ unit?: Unit; tokens: Token[] }>("/api/tokens");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(scope: "read" | "render") {
    try {
    const name = await appPrompt(
      scope === "render" ? "New token — can generate" : "New read-only token",
      "", "What is it for? e.g. your assistant"
    );
    if (!name?.trim()) return;
    /* A token that can generate is made only once its ceiling is settled, in
       the workspace's unit: Cancel makes nothing, and anything that does not
       read as credits (or dollars, on a workspace's own keys) asks again. */
    const unit: Unit | null = data?.unit
      ?? (await scopedFetch("/api/tokens", { cache: "no-store" }).then((r) => r.json()).then((j: { unit?: Unit }) => j.unit ?? "usd").catch(() => null));
    if (!unit) { await appAlert("Couldn't create the token", "Your tokens could not be read. Reload the page and try again."); return; }
    let ceiling: { capUsd: number | null } | { capCredits: number | null } = unit === "credits" ? { capCredits: null } : { capUsd: null };
    if (scope === "render") {
      let typed = unit === "credits" ? "500" : "20", problem: string | undefined;
      for (;;) {
        const answer = await appPrompt("Monthly ceiling", typed, unit === "credits" ? "Credits — blank for no limit" : "USD — blank for no limit", problem);
        if (answer === null) return;
        const read = unit === "credits" ? parseCreditCeiling(answer) : parseCeiling(answer);
        if ("error" in read) { typed = answer; problem = read.error; continue; }
        ceiling = read;
        break;
      }
    }
    const res = await scopedFetch("/api/tokens", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scope, ...ceiling }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { appAlert("Couldn't create the token", json.error); return; }
    setFresh({ name: json.name, token: json.token });
    setCopied(false);
    onNewToken?.(json.token);
    refresh();
    } catch (error) {
      await appAlert("Couldn't create the token", (error as Error).message);
    }
  }

  async function revoke(t: Token) {
    try {
    if (!(await appConfirm(`Revoke "${t.name}"?`,
      "Anything using it stops working immediately.", { confirmLabel: "Revoke", danger: true }))) return;
    const response = await scopedFetch(`/api/tokens/${t.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The token could not be revoked.");
    refresh();
    } catch (error) {
      await appAlert("Couldn't revoke the token", (error as Error).message);
    }
  }

  const tokens = data?.tokens ?? [];

  return (
    <>
      {fresh && (
        <div className="mb-3 rounded-[var(--r)] bg-blue/8 p-4">
          <p className="text-[15px] font-semibold">Copy “{fresh.name}” now</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-dim">
            This is the only time it is shown. Lose it and you revoke it and make another.
          </p>
          <p className="mt-3 select-all break-all rounded-[10px] bg-panel px-3 py-2.5 font-mono text-[12.5px]">
            {fresh.token}
          </p>
          <div className="mt-3 flex gap-2">
            <button className="chip chip-blue !py-2"
              onClick={async () => {
                try { await navigator.clipboard.writeText(fresh.token); setCopied(true); }
                catch { /* select it by hand */ }
              }}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="chip !py-2 !text-dim" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      <div className="rows">
        {tokens.map((t) => (
          <div key={t.id} className="row">
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{t.name}</span>
              <span className="text-[13px] text-mute">
                {t.scope === "read" ? "Read-only" : "Can generate"}
                {data?.unit === "credits" ? (
                  <>
                    {t.capCredits != null && ` · ${cr(t.spendCredits ?? 0)} of ${cr(t.capCredits)} this month`}
                    {t.capCredits == null && (t.spendCredits ?? 0) > 0 && ` · ${cr(t.spendCredits ?? 0)} this month`}
                    {t.capCredits == null && t.legacyCeiling && " · ceiling set before credits"}
                  </>
                ) : (
                  <>
                    {t.capUsd != null && ` · ${usd(t.spendThisMonth ?? 0, 2)} of ${usd(t.capUsd, 2)} this month`}
                    {t.capUsd == null && (t.spendThisMonth ?? 0) > 0 && ` · ${usd(t.spendThisMonth ?? 0, 2)} this month`}
                  </>
                )}
                {" · "}{t.lastUsed ? `used ${timeAgo(t.lastUsed)}` : "never used"}
              </span>
            </span>
            <span className="row-value">
              <button className="text-[15px] text-lift" onClick={() => revoke(t)}>Revoke</button>
            </span>
          </div>
        ))}
        {tokens.length === 0 && <div className="row text-dim">No tokens yet</div>}
        <button className="row !text-blue" onClick={() => create("render")}>New token — can generate</button>
        <button className="row !text-blue" onClick={() => create("read")}>New token — read-only</button>
      </div>
    </>
  );
}
