"use client";
import { useState } from "react";
import { MODELS, displayModelName, isOffered } from "@/lib/models";
import { DEFAULT_ENHANCER, ENHANCER_LABEL, ENHANCER_NOTE, ENHANCER_PROVIDERS, isEnhancerProvider, type EnhancerProvider } from "@/lib/shell/enhancer";
import { EDIT_FORMAT_OPTIONS } from "@/lib/settingValues";
import { requestAccountRefresh } from "@/lib/workspace/data";
import { useSession } from "@/lib/session";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import type { SettingsFold } from "@/lib/shell/settings";
import { XaiEngineRow } from "../../crew/XaiEngineRow";
import { Btn, Folded, Note, Problem, Row } from "../parts";
import { reachRows, type ReachPlace } from "../model";
import { useRead, useWrite } from "../use-settings";
import { PromptRules } from "./PromptRules";

/**
 * Settings › Advanced (README § 3.5; Workspace's Engines and General tabs, Atomik's Models and Tools, § 1.2): three folds.
 *
 *  - Models: thinking for planning, engines for output. The thinking model is chosen per request in Atomik's panel (Auto
 *    starts there), so its row opens the panel. The default engines and the prompt enhancer are workspace settings an admin
 *    saves on PATCH /api/settings, with a toast that has Undo. Engines lists availability on Particl's own keys.
 *  - Tools: what Atomik reaches, each with where it opens.
 *  - Workspace: the name (the owner's), prompt rules, the container an edit comes back in, and the export (the owner's).
 *
 * Nothing here spends or prices. The design's "Depth" row is left out: the code has no such setting.
 */
type Settings = { settings: Record<string, string>; defaults: Record<string, string> };
type Keys = { keys: { name: string; label: string; does: string; set: boolean }[] };

export function AdvancedSection({ open }: { open: SettingsFold | null }) {
  return (
    <>
      <Models open={open} />
      <Tools open={open} />
      <Workspace open={open} />
    </>
  );
}

/** Saves one or more settings on the route, with the route's own refusals, and an Undo that writes the old values back. */
function useSave(reload: () => void) {
  const write = useWrite();
  const { toast } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (values: Record<string, string>, before: Record<string, string>, said: string) => {
    if (busy) return;
    setBusy(true); setNote(null);
    const { error } = await write("/api/settings", "PATCH", values);
    setBusy(false);
    if (error) { setNote({ ok: false, text: error }); return; }
    reload();
    toast(said, { label: "Undo", kind: "undo", run: () => { void write("/api/settings", "PATCH", before).then(({ error: refused }) => { if (refused) toast(refused); else { reload(); toast("Put back."); } }); } });
  };
  return { save, busy, note };
}

const ENGINES = (kind: "video" | "image") => MODELS.filter((m) => m.kind === kind && !m.hidden && isOffered(m));

function Models({ open }: { open: SettingsFold | null }) {
  const session = useSession();
  const shell = useShell();
  const admin = session.role === "admin" || session.role === "owner";
  const settings = useRead<Settings>("/api/settings");
  const keys = useRead<Keys>("/api/workspaces/keys");
  const { save, busy, note } = useSave(() => void settings.read());
  const [listing, setListing] = useState(false);
  const value = (key: string) => settings.data?.settings[key] ?? settings.data?.defaults[key] ?? "";
  const house = session.rates.unit === "usd";
  const engines = (keys.data?.keys ?? []).filter((k) => k.name !== "xai");
  const available = engines.filter((k) => k.set).length;
  const enhancer: EnhancerProvider = isEnhancerProvider(value("promptEnhancer")) ? (value("promptEnhancer") as EnhancerProvider) : DEFAULT_ENHANCER;
  const engineSelect = (key: "defaultVideoModel" | "defaultImageModel", kind: "video" | "image", label: string) => {
    const options = [["", "Platform default"], ...ENGINES(kind).map((m) => [m.id, displayModelName(m.id)] as const)] as readonly (readonly [string, string])[];
    const current = value(key);
    const shown = options.find(([id]) => id === current)?.[1] ?? "Platform default";
    return (
      <Row name={label} line={admin ? "The engine Make starts with" : "An admin chooses this"} value={admin ? undefined : shown} testId={`settings-${key}`}>
        {admin ? (
          <select className="gs-sel" aria-label={label} value={options.some(([id]) => id === current) ? current : ""} disabled={busy || !settings.data}
            onChange={(e) => void save({ [key]: e.target.value }, { [key]: current }, `${label}: ${options.find(([id]) => id === e.target.value)?.[1] ?? "Platform default"}.`)} data-testid={`settings-${key}-select`}>
            {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        ) : null}
      </Row>
    );
  };
  return (
    <Folded name="models" open={open} label="Models" meta="thinking for planning · engines for output">
      {settings.error ? <Problem text={settings.error} onRetry={() => void settings.read()} /> : null}
      <Row name="Thinking model" line="Claude, OpenAI and Grok · Auto starts here" value="Auto" testId="settings-thinking">
        <Btn onClick={() => shell.openAtomik("panel")} testId="settings-thinking-change">Change</Btn>
      </Row>
      <Row name="Reasoning effort" line="Chosen for each request" value="Auto" testId="settings-effort" />
      {engineSelect("defaultVideoModel", "video", "Default video engine")}
      {engineSelect("defaultImageModel", "image", "Default image engine")}
      <Row name="Prompt enhancer" line={`${ENHANCER_NOTE[enhancer]} A local enhancement costs 1 cr.`} testId="settings-enhancer">
        <span className="gs-choice gs-choice-wrap" role="radiogroup" aria-label="Prompt enhancer">
          {ENHANCER_PROVIDERS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={enhancer === p} className="gs-btn" disabled={!admin || busy || !settings.data}
              onClick={() => { if (p !== enhancer) void save({ promptEnhancer: p }, { promptEnhancer: enhancer }, `Prompt enhancer: ${ENHANCER_LABEL[p]}.`); }} data-testid={`settings-enhancer-${p}`}>{ENHANCER_LABEL[p]}</button>
          ))}
        </span>
      </Row>
      <Row name="Engines" line={house ? "Managed by Particl. This house workspace runs on the platform’s engines and is not billed in credits." : "on Particl’s own keys"}
        value={keys.data ? `${available} available` : keys.error ? "—" : "Reading…"} testId="settings-engines">
        <Btn pressed={listing} onClick={() => setListing((v) => !v)} testId="settings-engines-show">{listing ? "Hide" : "Show"}</Btn>
      </Row>
      {keys.error ? <Problem text={keys.error} onRetry={() => void keys.read()} /> : null}
      {listing ? engines.map((k) => <Row key={k.name} name={k.label} line={k.does} value={k.set ? "Available" : "Unavailable"} testId="settings-engine" />) : null}
      {listing ? <div className="gs-embed"><XaiEngineRow /></div> : null}
      {note ? <Note ok={note.ok} text={note.text} testId="settings-advanced-note" /> : null}
    </Folded>
  );
}

function Tools({ open }: { open: SettingsFold | null }) {
  const shell = useShell();
  const go = (place: ReachPlace) => {
    if (place.to === "atomik") shell.openAtomik("panel");
    else if (place.to === "make") shell.openMake();
    else if (place.to === "settings") shell.goWorkspace(place.section, place.open ? { open: place.open } : undefined);
    else shell.goSuite(place.suite, place.page);
  };
  const rows = reachRows();
  return (
    <Folded name="tools" open={open} label="Tools" meta="what Atomik reaches">
      {rows.map((r) => (
        <Row key={r.id} name={r.label} line={r.line} value="Built in" testId="settings-reach">
          <Btn onClick={() => go(r.place)} testId="settings-reach-open">{r.action}</Btn>
        </Row>
      ))}
      <Row name="MCP tools" line="render_shot and the rest, for your own assistant" testId="settings-reach-mcp">
        <Btn onClick={() => shell.goWorkspace("connections", { open: "mcp" })} testId="settings-reach-mcp-open">Open</Btn>
      </Row>
    </Folded>
  );
}

function Workspace({ open }: { open: SettingsFold | null }) {
  const session = useSession();
  const write = useWrite();
  const admin = session.role === "admin" || session.role === "owner";
  const owner = session.owner;
  const settings = useRead<Settings>("/api/settings");
  const { save, busy, note } = useSave(() => void settings.read());
  const name = session.workspace?.name ?? "";
  const [title, setTitle] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameNote, setRenameNote] = useState<{ ok: boolean; text: string } | null>(null);
  const typed = (title ?? name).trim();
  const format = settings.data ? (settings.data.settings.editOutputFormat ?? settings.data.defaults.editOutputFormat) === "mov" ? "mov" : "mp4" : null;
  const rename = async () => {
    if (renaming || !typed || typed === name) return;
    setRenaming(true); setRenameNote(null);
    const { error } = await write("/api/workspaces", "PATCH", { name: typed });
    setRenaming(false);
    if (error) { setRenameNote({ ok: false, text: error }); return; }
    setTitle(null); requestAccountRefresh();
    setRenameNote({ ok: true, text: "Renamed." });
  };
  return (
    <Folded name="workspace" open={open} label="Workspace" meta="name, prompt rules, edit format, export">
      <Row name="Workspace name" line={owner ? undefined : "The owner names the workspace."} testId="settings-ws-name">
        {owner ? (
          <form className="gs-capform" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
            <input className="gs-field" value={title ?? name} maxLength={80} aria-label="Workspace name" onChange={(e) => setTitle(e.target.value)} data-testid="settings-ws-name-field" />
            <button type="submit" className="gs-btn" data-hot disabled={renaming || !typed || typed === name} data-testid="settings-ws-name-save">{renaming ? "Saving…" : "Rename"}</button>
          </form>
        ) : <span className="gs-row-v">{name}</span>}
      </Row>
      {renameNote ? <Note ok={renameNote.ok} text={renameNote.text} testId="settings-ws-note" /> : null}
      <Row name="Edit & extend container" line="What an edit or an extension comes back in" testId="settings-format">
        <span className="gs-choice" role="radiogroup" aria-label="Edit and extend container">
          {EDIT_FORMAT_OPTIONS.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={format === id} className="gs-btn" disabled={!admin || busy || !format}
              onClick={() => { if (format && id !== format) void save({ editOutputFormat: id }, { editOutputFormat: format }, `Edit & extend container: ${label}.`); }} data-testid={`settings-format-${id}`}>{label}</button>
          ))}
        </span>
      </Row>
      {note ? <Note ok={note.ok} text={note.text} testId="settings-workspace-note" /> : null}
      <PromptRules />
      {owner ? (
        <Row name="Export" line="Everything in this workspace, to keep" testId="settings-export">
          <a className="gs-btn" href="/api/export" download>Workspace · JSON</a>
          <a className="gs-btn" href="/api/export?format=csv" download>Takes · CSV</a>
        </Row>
      ) : null}
    </Folded>
  );
}
