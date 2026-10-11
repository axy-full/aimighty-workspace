"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { fmtCredits } from "@/lib/price";
import { creditRate, creditsUsd } from "@/lib/shell/price-words";
import { ASPECTS, enginePicks } from "@/lib/v12/settingsConsole";
import { useWorkspace } from "@/lib/workspace/state";
import { useRead, useWrite } from "@/components/graphite/settings/use-settings";
import { Note, Problem, Row, Sec, Switch } from "./parts";

/**
 * Settings › Defaults: how new work starts here. Enhance on or off by default (where the workspace has the switch), the engine
 * Make opens on per kind, and the shape a new board starts in. Each saves itself (PATCH /api/settings, an admin's) and says so
 * with an Undo. Engines are the registry's, with today's price from the server's rate card; "Particl's default" inherits.
 */
type Settings = { settings: Record<string, string>; defaults: Record<string, string> };
type Rates = { rates?: Parameters<typeof enginePicks>[0] };

export function Defaults() {
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const settings = useRead<Settings>("/api/settings");
  const inCredits = session.rates.unit === "cr" && Boolean(session.credits);
  const billing = useRead<Rates>(inCredits ? "/api/billing" : null);
  const rate = creditRate(session.rates.creditUsd);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const value = (key: string) => settings.data?.settings[key] ?? settings.data?.defaults[key] ?? "";
  const has = (key: string) => settings.data ? key in settings.data.defaults : false;

  const save = async (key: string, next: string, label: string) => {
    const was = value(key);
    if (was === next) return;
    setBusy(true); setNote(null);
    const { error } = await write("/api/settings", "PATCH", { [key]: next });
    setBusy(false);
    if (error) { setNote(error); return; }
    await settings.read();
    toast(`${label}.`, { label: "Undo", kind: "undo", run: () => { void write("/api/settings", "PATCH", { [key]: was }).then(() => settings.read()); } });
  };

  const picker = (key: "defaultVideoModel" | "defaultImageModel", kind: "video" | "image", name: string) => {
    const picks = enginePicks(billing.data?.rates, kind);
    const current = value(key);
    const known = picks.some((p) => p.id === current);
    return (
      <Row name={name} line="The engine Make opens on" testId={`v12-settings-${key}`}>
        <select className="v12-ws-select" aria-label={name} value={known ? current : current ? current : ""} disabled={busy || !settings.data || !billing.data}
          onChange={(e) => void save(key, e.target.value, `${name}: ${picks.find((p) => p.id === e.target.value)?.label ?? "Particl’s default"}`)} data-testid={`v12-settings-${key}-select`}>
          <option value="">Particl’s default</option>
          {!known && current ? <option value={current}>{current}</option> : null}
          {picks.map((p) => <option key={p.id} value={p.id} title={creditsUsd(p.credits, rate) ?? undefined}>{p.label} · {p.at} · {fmtCredits(p.credits)}</option>)}
        </select>
      </Row>
    );
  };

  return (
    <Sec testId="v12-settings-defaults">
      {settings.error ? <Problem text={settings.error} onRetry={() => void settings.read()} /> : null}
      {has("enhanceDefault") ? (
        <Switch on={value("enhanceDefault") !== "off"} disabled={busy || !settings.data} name="Enhance by default" state={value("enhanceDefault") !== "off" ? "On" : "Off"}
          line="New composers start with Enhance on: Particl rewrites the prompt for the engine before it runs. Anyone can still switch it per take."
          onChange={(next) => void save("enhanceDefault", next ? "on" : "off", `Enhance by default: ${next ? "on" : "off"}`)} testId="v12-settings-enhance-default" />
      ) : null}
      {inCredits ? picker("defaultVideoModel", "video", "Default video engine") : null}
      {inCredits ? picker("defaultImageModel", "image", "Default still engine") : null}
      <Row name="Default aspect" line="The shape a new board starts in" testId="v12-settings-defaultAspect">
        <span className="v12-ws-seg" role="group" aria-label="Default aspect">
          <button type="button" aria-pressed={!value("defaultAspect")} disabled={busy || !settings.data} onClick={() => void save("defaultAspect", "", "Default aspect: Particl’s default")}>Particl’s default</button>
          {ASPECTS.map((a) => <button key={a} type="button" aria-pressed={value("defaultAspect") === a} disabled={busy || !settings.data} onClick={() => void save("defaultAspect", a, `Default aspect: ${a}`)} data-testid={`v12-settings-aspect-${a.replace(":", "x")}`}>{a}</button>)}
        </span>
      </Row>
      {billing.error ? <Problem text={billing.error} onRetry={() => void billing.read()} /> : null}
      {note ? <Note ok={false} text={note} /> : null}
      <div className="v12-ws-row-line" style={{ paddingTop: 8 }}>Only engines Particl offers are listed, with today’s price. Particl’s own defaults apply where nothing is set here.</div>
    </Sec>
  );
}
