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

type Me = { name: string; email: string; role: string };
type Usage = { spentUsd: number; purchasedUsd: number; remainingUsd: number };

export default function SettingsPage() {
  const prefs = usePrefs();
  const model = getModel(prefs.modelId);
  const router = useRouter();
  const { data: me } = useApi<Me>("/api/me");
  const { data: usage } = useApi<Usage>("/api/usage/summary", 30000);
  const [busy, setBusy] = useState(false);

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
              const i = MODELS.findIndex((m) => m.id === prefs.modelId);
              const next = MODELS[(i + 1) % MODELS.length];
              setPrefs({
                modelId: next.id,
                resolution: next.resolutions.includes(prefs.resolution)
                  ? prefs.resolution : next.resolutions[next.resolutions.length - 1],
                duration: next.durations.includes(prefs.duration)
                  ? prefs.duration : next.durations[0],
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
          <Cycle
            label="Duration"
            value={`${prefs.duration}s`}
            onPick={() => {
              const list = model.durations;
              const i = list.indexOf(prefs.duration);
              setPrefs({ duration: list[(i + 1) % list.length] });
            }}
          />
        </div>
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          What the composer starts on. Saved in this browser.
        </p>

        <p className="grouplabel mt-10">Credit</p>
        <div className="rows">
          <div className="row">
            Spent all time
            <span className="row-value">{usage ? usd(usage.spentUsd, 2) : "—"}</span>
          </div>
          <div className="row">
            Credit recorded
            <span className="row-value">{usage ? usd(usage.purchasedUsd, 2) : "—"}</span>
          </div>
          <div className="row">
            Remaining
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
          BytePlus doesn&apos;t publish a balance over the API, so credit is what you record
          on the Usage page, drawn down by the real cost of every render.
        </p>

        <p className="grouplabel mt-10">Notifications</p>
        <div className="rows">
          <PushRow />
        </div>

        <WorkspaceSettings isAdmin={me?.role === "admin"} />

        <p className="grouplabel mt-10">Workspace</p>
        <div className="rows">
          <div className="row">
            Signed in
            <span className="row-value">{me?.name ?? "…"}</span>
          </div>
          <button className="row" onClick={() => router.push("/connect")}>
            Connect apps &amp; tokens
            <span className="row-value">
              Claude · ChatGPT · CLI
              <IconChevron className="!text-mute" />
            </span>
          </button>
          {me?.role === "admin" && (
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
             title="Every prompt, cost and account record as JSON">
            Export data
            <span className="row-value">JSON</span>
          </a>
          <button className="row !text-lift" onClick={signOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>

        <p className="mt-10 text-center text-[12px] text-mute">
          Particl · Seedance on BytePlus ModelArk
        </p>
      </div>
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

/* ── Push notifications, moved out of the chat header ─────────────────── */

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
      if (!PUSH_KEY) throw new Error("Push keys aren't in this build yet.");
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
    state === "denied" ? "Blocked in browser settings"
    : state === "install" ? "Add to Home Screen first"
    : state === "unconfigured" ? "Not configured" : null;

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
                : state === "install" ? "Install the app first" : "Push isn't configured",
              state === "denied"
                ? "Allow notifications for this site in your browser's settings, then come back."
                : state === "install"
                  ? "iPhones only deliver notifications to the installed app: Share → Add to Home Screen, open it from the icon, then turn this on there."
                  : "The VAPID keys aren't in this build. Add them in Vercel and redeploy."
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
