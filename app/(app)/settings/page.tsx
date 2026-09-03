"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MODELS, getModel } from "@/lib/models";
import { usePrefs, setPrefs } from "@/lib/prefs";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { appAlert } from "@/components/dialog";
import { Switch } from "@/components/Panel";
import { IconChevron } from "@/components/Icons";
import WorkspaceSettings from "@/components/WorkspaceSettings";
import { usePageTitle } from "@/lib/usePageTitle";
import ThemeRow from "@/components/ThemeRow";
import { ParticlMark } from "@/components/ParticlMark";

type Me = { name: string; email: string; role: string };
type Usage = { spentUsd: number; purchasedUsd: number; remainingUsd: number; promptSpendUsd?: number };
type Credits = { balanceUsd: number; usedUsd: number } | null;
type EngineInfo = {
  id: string; label: string; envKey: string; docs: string; configured: boolean; safety?: string;
  via?: "key" | "gateway" | null;
  models: { id: string; label: string; kind: "video" | "image" }[];
};
type Refiner = { writer: "none" | "byteplus" | "claude"; provider: string; model: string; label: string; via: string; configured: boolean };
type RefinerTest = {
  ok: boolean; ms: number; model?: string; sample?: string; move?: string | null; error?: string;
};

export default function SettingsPage() {
  usePageTitle("Settings");
  const prefs = usePrefs();
  const model = getModel(prefs.modelId);
  const router = useRouter();
  const { data: me } = useApi<Me>("/api/me");
  const { data: usage } = useApi<Usage>("/api/usage/summary", 30000);
  const { data: engineData, refresh: refreshEngines } = useApi<{ engines: EngineInfo[]; refiner?: Refiner; gatewayCredits?: Credits }>("/api/engines");
  const [busy, setBusy] = useState(false);
  const isAdmin = me?.role === "admin";

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[560px]">
        <h1 className="h1 pt-6">Settings</h1>

        <p className="grouplabel mt-10">Defaults</p>
        <div className="rows">
          <Cycle
            label="Model"
            value={model.label}
            onPick={() => {
              // Only engines this deployment can actually reach — a default
              // that fails on submit is worse than no default.
              const keyed = new Set((engineData?.engines ?? []).filter((e) => e.configured).map((e) => e.id));
              const list = MODELS.filter((m) => !m.hidden && (keyed.size === 0 || keyed.has(m.provider)));
              const i = list.findIndex((m) => m.id === prefs.modelId);
              const next = list[(i + 1) % list.length] ?? MODELS[0];
              setPrefs({
                modelId: next.id,
                resolution: next.resolutions.includes(prefs.resolution)
                  ? prefs.resolution
                  : next.kind === "image" ? "2K" : next.resolutions[next.resolutions.length - 1],
                duration: next.durations.includes(prefs.duration)
                  ? prefs.duration : next.durations[0] ?? prefs.duration,
              });
            }}
          />
          <Cycle
            label="Resolution"
            value={prefs.resolution.toUpperCase()}
            onPick={() => {
              const list = model.resolutions;
              const i = list.indexOf(prefs.resolution);
              setPrefs({ resolution: list[(i + 1) % list.length] });
            }}
          />
          {model.durations.length > 0 && (
            <Cycle
              label="Duration"
              value={`${prefs.duration}s`}
              onPick={() => {
                const list = model.durations;
                const i = list.indexOf(prefs.duration);
                setPrefs({ duration: list[(i + 1) % list.length] });
              }}
            />
          )}
        </div>
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          What the composer opens with. Saved in this browser only.
        </p>

        <p className="grouplabel mt-10">Engines</p>
        <div className="rows">
          {(engineData?.engines ?? []).map((e) => (
            <div key={e.id} className="row">
              <span className="min-w-0 flex-1">
                {e.label}
                <span className="mt-0.5 block text-[12px] leading-snug text-mute">
                  {e.models.map((m) => m.label).join(" · ")}
                  {e.configured && e.via === "gateway" && <> — through Vercel AI Gateway, on the same credit as the prompt writer.</>}
                  {e.safety && <> Safety thresholds: <span className="font-medium">{e.safety === "OFF" ? "off" : e.safety.toLowerCase().replace(/_/g, " ")}</span>; Google&rsquo;s built-in image filter stays.</>}
                  {!e.configured && isAdmin && (
                    <> — set <code className="font-mono text-[11.5px]">{e.envKey}</code> in
                    Vercel → Settings → Environment Variables, then redeploy.</>
                  )}
                </span>
              </span>
              <span className={`row-value !text-[13px] font-medium ${e.configured ? "!text-ok" : "!text-mute"}`}>
                <span className="lamp" />
                {e.configured ? "Connected" : "No key"}
              </span>
            </div>
          ))}
          {!engineData && (
            <div className="row"><span className="text-[14px] text-mute">Checking the keys…</span></div>
          )}
        </div>
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          Keys live on the server as environment variables and are never shown here.
          An engine without a key stays in the composer&rsquo;s menu, greyed out.
        </p>

        <p className="grouplabel mt-10">Prompt</p>
        <div className="rows">
          {engineData?.refiner
            ? <WriterRow writer={engineData.refiner} credits={engineData.gatewayCredits ?? null} isAdmin={isAdmin} onChanged={refreshEngines} />
            : <div className="row"><span className="text-[14px] text-mute">Reading the workspace&rsquo;s choice…</span></div>}
        </div>
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          Who finishes an idea too thin to film. The library&rsquo;s camera modules apply in every
          mode; this only decides whether a model rewrites the words first. Start a prompt with{" "}
          <span className="font-medium text-blue">raw:</span> to bypass everything for one render.
        </p>

        <p className="grouplabel mt-10">Credit</p>
        <div className="rows">
          <div className="row">
            Spent, all time
            <span className="row-value">{usage ? usd(usage.spentUsd, 2) : "—"}</span>
          </div>
          <div className="row">
            Credit added
            <span className="row-value">{usage ? usd(usage.purchasedUsd, 2) : "—"}</span>
          </div>
          <div className="row">
            <span className="flex flex-col">
              Remaining
              {usage && (usage.promptSpendUsd ?? 0) > 0 && (
                <span className="text-[12px] text-mute">
                  Of the spend, {usd(usage.promptSpendUsd ?? 0, 3)} went to prompt writing.
                </span>
              )}
            </span>
            <span className={`row-value font-medium ${usage && usage.remainingUsd < 0 ? "!text-lift" : "!text-bone"}`}>
              {usage ? usd(usage.remainingUsd, 2) : "—"}
            </span>
          </div>
          <button className="row" onClick={() => router.push("/usage")}>
            Record a top-up
            <span className="row-value"><IconChevron className="!text-mute" /></span>
          </button>
        </div>
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          BytePlus doesn&rsquo;t expose a balance through its API, so your credit is
          whatever you record on the Usage page, drawn down by the real cost of each render.
        </p>

        <p className="grouplabel mt-10">Appearance</p>
        <div className="rows">
          <ThemeRow />
        </div>

        <p className="grouplabel mt-10">Notifications</p>
        <div className="rows">
          <PushRow />
        </div>

        <WorkspaceSettings isAdmin={isAdmin} />

        <p className="grouplabel mt-10">Workspace</p>
        <div className="rows">
          <div className="row">
            Signed in as
            <span className="row-value">{me?.name ?? "…"}</span>
          </div>
          <button className="row" onClick={() => router.push("/connect")}>
            Connect apps &amp; tokens
            <span className="row-value">
              Claude · ChatGPT · CLI
              <IconChevron className="!text-mute" />
            </span>
          </button>
          {isAdmin && (
            <button className="row" onClick={() => router.push("/team")}>
              Team &amp; invites
              <span className="row-value"><IconChevron className="!text-mute" /></span>
            </button>
          )}
          <button className="row" onClick={() => router.push("/platform")}>
            Platform
            <span className="row-value">
              Assets · APIs · security · IP
              <IconChevron className="!text-mute" />
            </span>
          </button>
          <a className="row" href="/api/export" download
             title="Every prompt, cost and account record, as JSON">
            Export data
            <span className="row-value">JSON</span>
          </a>
          <button className="row !text-lift" onClick={signOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>

        <div className="mt-10 flex flex-col items-center gap-2 text-center text-[12px] text-mute">
          <ParticlMark size={12} className="text-mute/70" />
          <span>particl studio · Seedance on BytePlus ModelArk · Nano Banana on Google, through Vercel AI Gateway</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The workspace's writer, as a three-way choice, and a way to hear it answer.
 * Through Vercel AI Gateway the credentials are the deployment's own, so the
 * one thing that can still be missing is credit on the gateway — which is
 * exactly what a test call reports in plain words.
 */
const WRITERS: { id: Refiner["writer"]; label: string; blurb: string }[] = [
  { id: "none", label: "Pro", blurb: "No rewriting. Your words reach the engine exactly as written." },
  { id: "byteplus", label: "Seedream", blurb: "ByteDance's own text model finishes thin ideas, on the ModelArk key." },
  { id: "claude", label: "Claude Opus 5", blurb: "Anthropic's Opus 5 finishes thin ideas, through Vercel AI Gateway." },
];

function WriterRow({ writer, credits, isAdmin, onChanged }: { writer: Refiner; credits: Credits; isAdmin: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<RefinerTest | null>(null);
  const current = WRITERS.find((w) => w.id === writer.writer) ?? WRITERS[2];

  async function choose(id: Refiner["writer"]) {
    if (!isAdmin || saving || id === writer.writer) return;
    setSaving(true); setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptWriter: id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't save that");
      onChanged();
    } catch (e) {
      await appAlert("Couldn't change the writer", (e as Error).message);
    } finally { setSaving(false); }
  }

  async function test() {
    setBusy(true); setResult(null);
    try {
      const res = await fetch("/api/engines/test", { method: "POST" });
      setResult(await res.json());
    } catch (e) {
      setResult({ ok: false, ms: 0, error: (e as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <div className="row !block py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          Prompt writer
          <span className="mt-0.5 block text-[12px] leading-snug text-mute">
            {current.blurb}{writer.writer !== "none" ? ` Currently ${writer.label} · ${writer.via}.` : ""}
            {credits && writer.writer === "claude" && (
              <> Gateway credit: <span className="text-dim">{usd(credits.balanceUsd, 2)}</span> left, {usd(credits.usedUsd, 3)} used.</>
            )}
          </span>
        </span>
        <span className="inline-flex rounded-[10px] bg-chip p-[3px]" role="radiogroup" aria-label="Prompt writer">
          {WRITERS.map((w) => {
            const on = writer.writer === w.id;
            return (
              <button key={w.id} type="button" role="radio" aria-checked={on}
                disabled={!isAdmin || saving}
                onClick={() => choose(w.id)}
                className={`rounded-[8px] px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-default ${
                  on ? "bg-panel text-ink shadow-[var(--shadow-card)]" : "text-dim"
                }`}>
                {w.label}
              </button>
            );
          })}
        </span>
      </div>
      {(isAdmin || result) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {isAdmin && writer.writer !== "none" && (
            <button type="button" onClick={test} disabled={busy}
              className="chip !py-1.5 !text-[13px] !text-blue disabled:opacity-50">
              {busy ? "Asking…" : "Test the writer"}
            </button>
          )}
          {!writer.configured && writer.writer !== "none" && (
            <span className="text-[12.5px] text-warn">Not reachable from this deployment.</span>
          )}
          {result && (
            <span className={`text-[12.5px] leading-snug ${result.ok ? "text-dim" : "text-lift"}`}>
              {result.ok
                ? <>{result.ms ? `Answered in ${(result.ms / 1000).toFixed(1)}s` : ""}{result.move ? `, chose “${result.move}”` : ""}{result.ms ? ": " : ""}<span className="italic">{result.sample}</span></>
                : result.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A row that steps through its options in place — no drill-in for three items. */
function Cycle({ label, value, onPick }: { label: string; value: string; onPick: () => void }) {
  return (
    <button className="row" onClick={onPick}>
      {label}
      <span className="row-value">
        {value}
        <IconChevron className="!text-mute" />
      </span>
    </button>
  );
}

/* ── Push notifications ───────────────────────────────────────────────── */

const PUSH_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlB64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function PushRow() {
  type PushState = "off" | "on" | "busy" | "denied" | "install" | "unconfigured" | "unsupported";
  // Starts "off" on both server and client — anything read from `navigator`
  // during render would hydrate differently than it rendered.
  const [state, setState] = useState<PushState>("off");

  useEffect(() => {
    let alive = true;
    // A microtask boundary keeps this out of the render pass entirely.
    Promise.resolve().then(async () => {
      if (!("serviceWorker" in navigator && "PushManager" in window)) {
        const ios = /iP(hone|ad|od)/.test(navigator.userAgent) &&
          !matchMedia("(display-mode: standalone)").matches;
        if (alive) setState(ios ? "install" : "unsupported");
        return;
      }
      if (!PUSH_KEY) { if (alive) setState("unconfigured"); return; }
      if (Notification.permission === "denied") { if (alive) setState("denied"); return; }
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      const on = Boolean(reg && (await reg.pushManager.getSubscription()));
      if (alive && on) setState("on");
    });
    return () => { alive = false; };
  }, []);

  async function enable() {
    setState("busy");
    try {
      if (!PUSH_KEY) throw new Error("The push keys aren't in this build yet.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return; }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(PUSH_KEY),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The server rejected it.");
      setState("on");
    } catch (e) {
      appAlert("Couldn't turn on notifications", (e as Error).message);
      setState(PUSH_KEY ? "off" : "unconfigured");
    }
  }

  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } finally { setState("off"); }
  }

  if (state === "unsupported") return null;

  const note =
    state === "denied" ? "Blocked in your browser's settings"
    : state === "install" ? "Add Particl to your Home Screen first"
    : state === "unconfigured" ? "Not set up on this deployment" : null;

  return (
    <div className="row">
      <span className="flex flex-col">
        Chat notifications
        {note && <span className="text-[13px] text-mute">{note}</span>}
      </span>
      <span className="row-value">
        {note ? (
          <button
            className="text-[15px] text-blue"
            onClick={() => appAlert(
              state === "denied" ? "Notifications are blocked"
                : state === "install" ? "Install the app first" : "Push isn't set up",
              state === "denied"
                ? "Allow notifications for this site in your browser's settings, then come back here."
                : state === "install"
                  ? "On iPhone, notifications only reach the installed app. Tap Share, then Add to Home Screen, open Particl from the icon, and turn this on there."
                  : "The push keys aren't on this deployment. Add them in Vercel and redeploy."
            )}
          >
            Why?
          </button>
        ) : (
          <Switch
            checked={state === "on"}
            disabled={state === "busy"}
            onChange={(v) => (v ? enable() : disable())}
          />
        )}
      </span>
    </div>
  );
}
