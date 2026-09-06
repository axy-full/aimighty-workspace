"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usd, timeAgo } from "@/lib/format";
import { appAlert, appConfirm, appPrompt } from "./dialog";

export type Token = {
  id: string; name: string; scope: "read" | "render";
  capUsd: number | null; spendThisMonth: number;
  lastUsed: number | null; createdAt: number;
};

/**
 * Making and revoking the keys that let something outside a browser in.
 * The secret is shown exactly once — after that only its hash exists.
 */
export default function Tokens({ onNewToken }: { onNewToken?: (t: string) => void }) {
  const { data, refresh } = useApi<{ tokens: Token[] }>("/api/tokens");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(scope: "read" | "render") {
    const name = await appPrompt(
      scope === "render" ? "New token — can generate" : "New read-only token",
      "", "What is it for? e.g. Claude"
    );
    if (!name?.trim()) return;
    const cap = scope === "render"
      ? await appPrompt("Monthly ceiling", "20", "USD — blank for no limit")
      : null;
    const res = await fetch("/api/tokens", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scope, capUsd: cap ? Number(cap) : null }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { appAlert("Couldn't create the token", json.error); return; }
    setFresh({ name: json.name, token: json.token });
    setCopied(false);
    onNewToken?.(json.token);
    refresh();
  }

  async function revoke(t: Token) {
    if (!(await appConfirm(`Revoke "${t.name}"?`,
      "Anything using it stops working immediately.", { confirmLabel: "Revoke", danger: true }))) return;
    await fetch(`/api/tokens/${t.id}`, { method: "DELETE" });
    refresh();
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
                {t.capUsd != null && ` · ${usd(t.spendThisMonth, 2)} of ${usd(t.capUsd, 2)} this month`}
                {t.capUsd == null && t.spendThisMonth > 0 && ` · ${usd(t.spendThisMonth, 2)} this month`}
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
