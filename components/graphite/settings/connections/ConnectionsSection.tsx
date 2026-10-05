"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { CLIENTS, DEFAULT_CEILING, mcpEndpoint, mcpTools, parseTokens, readCeiling, setupGuide, tokenBody, type ApiToken, type ClientId, type TokenUnit } from "@/lib/shell/tools-connections";
import type { SettingsFold } from "@/lib/shell/settings";
import { ConnectedAccountRow } from "../../ConnectedAccountRow";
import { Btn, CopyBlock, Folded, Note, Problem, Row, Section } from "../parts";
import { PUBLISHING_ACCOUNTS, tokenLine, tokenValue } from "../model";
import { useRead, useWrite } from "../use-settings";

/**
 * Settings › Connections (README § 3.5, § 4 "MCP tokens"): Particl as an MCP server, and the tokens that reach it.
 * The rows are the person's own tokens (GET /api/tokens). Revoking disables a token at once and erases nothing.
 * A token's secret is shown once, here, and never stored. Copy says what the code does: a "Can generate" token
 * starts takes inside the monthly ceiling a person set; a read-only one is refused every paid call (DECISIONS 2).
 * Publishing accounts are listed as not connected, with no Connect, until posting exists (DECISIONS 3).
 * Nothing here spends, and a token cannot make a token: a person's session does.
 */
const noop = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "";

export function ConnectionsSection({ open }: { open: SettingsFold | null }) {
  const session = useSession();
  const [secret, setSecret] = useState("");
  return (
    <>
      <Tokens onFresh={setSecret} />
      <Assistant open={open} secret={secret} />
      <McpTools open={open} />
      <Section label="Publishing accounts" meta="every post is approved by a person" testId="settings-publishing">
        {PUBLISHING_ACCOUNTS.map((name) => <Row key={name} name={name} line="Not connected · posting is not in Particl yet" value="—" testId="settings-publishing-row" />)}
      </Section>
      {session.owner ? <div className="gs-embed" data-testid="settings-earlier-account"><ConnectedAccountRow owner /></div> : null}
    </>
  );
}

function Tokens({ onFresh }: { onFresh: (secret: string) => void }) {
  const session = useSession();
  void session;
  const write = useWrite();
  const { toast } = useWorkspace();
  const { data, error, read } = useRead<unknown>("/api/tokens");
  const parsed = data ? parseTokens(data) : null;
  const unit: TokenUnit | null = parsed?.unit ?? null;
  const tokens: ApiToken[] = parsed?.tokens ?? [];
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"render" | "read">("render");
  const [ceiling, setCeiling] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [fresh, setFresh] = useState<{ id: string; name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const pressing = useRef(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (fresh) copyButton.current?.focus({ preventScroll: false }); }, [fresh]);

  const typed = ceiling ?? (unit ? DEFAULT_CEILING[unit] : "");
  const read_ = unit && scope === "render" ? readCeiling(typed, unit) : null;
  const unbounded = read_ != null && !("error" in read_) && read_.blank;

  const make = async () => {
    if (pressing.current || !unit) return;
    const trimmed = name.trim();
    if (!trimmed) { setNote({ ok: false, text: "Name it for what will use it, like “Claude on my laptop”." }); return; }
    if (read_ && "error" in read_) { setNote({ ok: false, text: read_.error }); return; }
    pressing.current = true; setBusy("make"); setNote(null);
    const { json, error: refused } = await write<{ id?: string; name?: string; token?: string }>("/api/tokens", "POST", tokenBody(trimmed, scope, unit, read_ && !("error" in read_) ? read_.value : null));
    pressing.current = false; setBusy(null);
    if (refused || typeof json?.token !== "string") { setNote({ ok: false, text: refused ?? "The token could not be made. Try again." }); return; }
    setFresh({ id: json.id ?? "", name: json.name ?? trimmed, token: json.token });
    setCopied(false); onFresh(json.token); setName(""); setCeiling(null); setMaking(false);
    void read();
  };
  const revoke = async (t: ApiToken) => {
    if (pressing.current) return;
    pressing.current = true; setBusy(t.id); setNote(null);
    const { error: refused } = await write(`/api/tokens/${encodeURIComponent(t.id)}`, "DELETE");
    pressing.current = false; setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); return; }
    setConfirming(null);
    if (fresh?.id === t.id) { setFresh(null); onFresh(""); }
    void read();
    toast(`“${t.name}” revoked. Anything using it is refused from its next call.`);
  };
  const copy = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh.token); setCopied(true); } catch { toast("Copy didn’t work here. Select the token and copy it."); }
  };

  return (
    <Section label="MCP for outside agents" meta="Particl is an MCP server · tokens you control" testId="settings-tokens"
      action={<button type="button" className="gs-primary" aria-expanded={making} disabled={!unit} onClick={() => setMaking((v) => !v)} data-testid="settings-token-make">Make a token</button>}>
      {error ? <Problem text={error} onRetry={() => void read()} testId="settings-tokens-error" /> : !data ? <Row name="Reading your tokens…" /> : null}
      {data && !parsed ? <Problem text="Your tokens could not be read." onRetry={() => void read()} /> : null}
      {parsed && !tokens.length ? <Row name="No tokens yet." line="Make one; it appears here with what it spent this month." testId="settings-tokens-empty" /> : null}
      {tokens.map((t) => (
        <Row key={t.id} name={t.name} line={unit ? tokenLine(t, unit) : undefined} value={tokenValue(t)} testId="settings-token">
          {confirming === t.id ? (
            <>
              <Btn danger disabled={busy != null} onClick={() => void revoke(t)} testId="settings-token-revoke-confirm">{busy === t.id ? "Revoking…" : "Revoke now"}</Btn>
              <Btn disabled={busy != null} onClick={() => setConfirming(null)} testId="settings-token-keep">Keep</Btn>
            </>
          ) : <Btn disabled={busy != null} onClick={() => { setConfirming(t.id); setNote(null); }} testId="settings-token-revoke">Revoke</Btn>}
        </Row>
      ))}
      {making && unit ? (
        <form className="gs-edit" onSubmit={(e) => { e.preventDefault(); void make(); }} data-testid="settings-token-form">
          <label className="gs-label"><span className="gs-eyebrow">Name</span>
            <input className="gs-field" value={name} maxLength={60} placeholder="What will use it?" autoComplete="off" onChange={(e) => { setName(e.target.value); setNote(null); }} data-testid="settings-token-name" />
          </label>
          <div className="gs-choice gs-choice-wrap" role="radiogroup" aria-label="What it can do">
            <button type="button" role="radio" aria-checked={scope === "render"} className="gs-btn" onClick={() => setScope("render")} data-testid="settings-token-scope-render">Can generate</button>
            <button type="button" role="radio" aria-checked={scope === "read"} className="gs-btn" onClick={() => setScope("read")} data-testid="settings-token-scope-read">Read-only</button>
          </div>
          {scope === "render" ? (
            <label className="gs-label"><span className="gs-eyebrow">{unit === "usd" ? "Monthly ceiling ($)" : "Monthly ceiling (cr)"}</span>
              <input className="gs-field" inputMode="numeric" value={typed} placeholder="No ceiling" onChange={(e) => { setCeiling(e.target.value); setNote(null); }} data-testid="settings-token-ceiling" />
            </label>
          ) : <p className="gs-row-line" data-testid="settings-token-read-note">Read-only: it can list and fetch takes, and every paid call is refused.</p>}
          {scope === "render" && unbounded ? <p className="gs-row-line" data-testid="settings-token-unbounded">No ceiling: it can spend until the workspace’s {unit === "usd" ? "engine balance" : "credits"} run out.</p> : null}
          <button type="submit" className="gs-btn" data-hot disabled={busy != null || !name.trim()} data-testid="settings-token-create">{busy === "make" ? "Making…" : unbounded ? "Make token without a ceiling" : "Make token"}</button>
        </form>
      ) : null}
      {fresh ? (
        <div className="gs-fresh" role="status" data-testid="settings-token-fresh">
          <span className="gs-row-line">Copy “{fresh.name}” now. It is shown once; the setup below has it filled in.</span>
          <code className="gs-code" data-testid="settings-token-secret">{fresh.token}</code>
          <span className="gs-row-acts">
            <button type="button" className="gs-btn" data-hot ref={copyButton} onClick={() => void copy()} data-testid="settings-token-copy">{copied ? "Copied" : "Copy token"}</button>
            <Btn onClick={() => { setFresh(null); onFresh(""); }} testId="settings-token-done">Done</Btn>
          </span>
        </div>
      ) : null}
      {note ? <Note ok={note.ok} text={note.text} testId="settings-tokens-note" /> : null}
    </Section>
  );
}

function Assistant({ open, secret }: { open: SettingsFold | null; secret: string }) {
  const origin = useSyncExternalStore(noop, readOrigin, serverOrigin);
  const [client, setClient] = useState<ClientId>("claude-code");
  const guide = origin ? setupGuide(client, origin, secret) : null;
  return (
    <Folded name="assistant" open={open} label="Add it to your assistant" meta="Claude, ChatGPT or any MCP client">
      <div className="gs-edit">
        <div className="gs-choice gs-choice-wrap" role="radiogroup" aria-label="Assistant">
          {CLIENTS.map((c) => <button key={c.id} type="button" role="radio" aria-checked={client === c.id} className="gs-btn" onClick={() => setClient(c.id)} data-testid={`settings-client-${c.id}`}>{c.label}</button>)}
        </div>
        {guide ? <p className="gs-row-line" data-testid="settings-setup-note">{guide.note}</p> : null}
        {guide?.steps.map((step, i) => <CopyBlock key={`${client}-${i}`} label={`${i + 1}. ${step.label}`} text={step.code} testId="settings-setup-step" />)}
        <p className="gs-row-line">{secret ? "Your new token is filled in above." : "Make a token and it is filled in here."}</p>
      </div>
    </Folded>
  );
}

function McpTools({ open }: { open: SettingsFold | null }) {
  const origin = useSyncExternalStore(noop, readOrigin, serverOrigin);
  const tools = mcpTools();
  return (
    <Folded name="mcp" open={open} label="What it can do" meta={`${tools.length} tools · a read-only token gets the reading ones`}>
      {origin ? <div className="gs-edit"><CopyBlock label="Server" text={mcpEndpoint(origin)} testId="settings-mcp-endpoint" /></div> : null}
      {tools.map((t) => <Row key={t.name} name={<span className="gs-mono">{t.name}</span>} line={t.line} value={t.token === "any" ? "Any token" : "Can generate"} testId="settings-mcp-tool" />)}
    </Folded>
  );
}
