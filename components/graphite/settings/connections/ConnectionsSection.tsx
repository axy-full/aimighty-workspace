"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useShell } from "@/lib/shell/state";
import { useCompact } from "@/lib/shell/use-compact";
import { stashGenPreset } from "@/lib/shell/gen-preset";
import { preparedModelId, preparedSpec, type PreparedJob } from "@/lib/security/prepared-words";
import "@/components/graphite/security/security.css";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { CLIENTS, DEFAULT_CEILING, ceilingBody, mcpEndpoint, mcpTools, parseTokens, readCeiling, setupGuide, tokenBody, type ApiToken, type ClientId, type TokenUnit } from "@/lib/shell/tools-connections";
import type { SettingsFold } from "@/lib/shell/settings";
import { Btn, CopyBlock, Folded, Note, Problem, Row, Section } from "../parts";
import { PUBLISHING_ACCOUNTS, tokenLine, tokenValue } from "../model";
import { useRead, useWrite } from "../use-settings";

/**
 * Settings › Connections (README § 3.5, § 4 "MCP tokens"): Particl as an MCP server, and the tokens that reach it.
 * The rows are the person's own tokens (GET /api/tokens). Revoking disables a token at once and erases nothing.
 * A token's secret is shown once, in the "Token created" dialog (Gaps B), and never stored. A new token reads, or
 * prepares jobs that wait here for a person; neither spends. A token that can generate starts paid jobs only inside the
 * monthly ceiling an admin set on it, carrying the quote it was approved at (owner, 20 Oct 2026, Q1 "B"; lib/tokenSpend.ts);
 * with no ceiling it only prepares and prices. An admin makes one with a ceiling, and sets or clears the ceiling of any
 * member's (PATCH /api/tokens/[id]/ceiling), with Undo; nobody else sees the field.
 * Publishing accounts are listed as not connected, with no Connect, until posting exists (DECISIONS 3).
 * Nothing here spends, and a token cannot make a token: a person's session does.
 */
const noop = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "";

export function ConnectionsSection({ open }: { open: SettingsFold | null }) {
  const [secret, setSecret] = useState("");
  return (
    <>
      <Tokens onFresh={setSecret} />
      <Assistant open={open} secret={secret} />
      <McpTools open={open} />
      <Section label="Publishing accounts" meta="every post is approved by a person" testId="settings-publishing">
        {PUBLISHING_ACCOUNTS.map((name) => <Row key={name} name={name} line="Not connected · posting is not in Particl yet" value="—" testId="settings-publishing-row" />)}
      </Section>
      {/* No connected Higgsfield account row: off for Release 1 with the Higgsfield sign-in (lib/higgsfield-consumer/retired.ts). */}
    </>
  );
}

function Tokens({ onFresh }: { onFresh: (secret: string) => void }) {
  const write = useWrite();
  const { toast } = useWorkspace();
  const session = useSession();
  /* Only an admin sets a ceiling (the server asks again: POST /api/tokens, PATCH /api/tokens/[id]/ceiling). */
  const admin = session.role === "admin" || session.role === "owner";
  const { data, error, read } = useRead<unknown>("/api/tokens");
  const parsed = data ? parseTokens(data) : null;
  const unit: TokenUnit | null = parsed?.unit ?? null;
  const tokens: ApiToken[] = parsed?.tokens ?? [];
  const others: ApiToken[] = admin ? parsed?.others ?? [] : [];
  const [dialog, setDialog] = useState<"new" | "shown" | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"prepare" | "read" | "render">("prepare");
  const [ceiling, setCeiling] = useState("");
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [fresh, setFresh] = useState<{ id: string; name: string; scope: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const pressing = useRef(false);
  const close = () => { setDialog(null); setNote(null); };

  /* A token made here reads, or prepares jobs a person approves (Gaps B); it never spends on its own. */
  const make = async () => {
    if (pressing.current || !unit) return;
    const trimmed = name.trim();
    if (!trimmed) { setNote({ ok: false, text: "Name it for what will use it, like “a script on the studio Mac”." }); return; }
    /* A token that can generate is an admin's to make, with its ceiling in the workspace's unit; blank is none (it then only prepares and prices). */
    const cap = scope === "render" ? readCeiling(ceiling, unit) : { value: null, blank: true };
    if ("error" in cap) { setNote({ ok: false, text: cap.error }); return; }
    pressing.current = true; setBusy("make"); setNote(null);
    const { json, error: refused } = await write<{ id?: string; name?: string; scope?: string; token?: string }>("/api/tokens", "POST", tokenBody(trimmed, scope, unit, cap.value));
    pressing.current = false; setBusy(null);
    if (refused || typeof json?.token !== "string") { setNote({ ok: false, text: refused ?? "The token could not be made. Try again." }); return; }
    setFresh({ id: json.id ?? "", name: json.name ?? trimmed, scope: json.scope ?? scope, token: json.token });
    setCopied(false); onFresh(json.token); setName(""); setDialog("shown");
    void read();
  };
  const revoke = async (t: { id: string; name: string }) => {
    if (pressing.current) return;
    pressing.current = true; setBusy(t.id); setNote(null);
    const { error: refused } = await write(`/api/tokens/${encodeURIComponent(t.id)}`, "DELETE");
    pressing.current = false; setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); return; }
    setConfirming(null);
    if (fresh?.id === t.id) { setFresh(null); onFresh(""); setDialog(null); }
    void read();
    toast(`“${t.name}” revoked. Anything using it is refused from its next call.`);
  };
  /* An admin sets or clears a ceiling; Undo puts the one before back (nothing is erased). */
  const saveCeiling = async (t: ApiToken) => {
    if (pressing.current || !unit || !edit) return;
    const cap = readCeiling(edit.value, unit);
    if ("error" in cap) { setNote({ ok: false, text: cap.error }); return; }
    const before = unit === "credits" ? t.capCredits ?? null : t.capUsd ?? null;
    const url = `/api/tokens/${encodeURIComponent(t.id)}/ceiling`;
    pressing.current = true; setBusy(t.id); setNote(null);
    const { error: refused } = await write(url, "PATCH", ceilingBody(unit, cap.value));
    pressing.current = false; setBusy(null);
    if (refused) { setNote({ ok: false, text: refused }); void read(); return; }
    setEdit(null);
    void read();
    toast(cap.value == null ? `“${t.name}” has no ceiling: it prepares and prices only.` : `“${t.name}” spends up to ${unit === "credits" ? `${cap.value.toLocaleString("en-US")} cr` : `$${cap.value}`} a month.`,
      { label: "Undo", kind: "undo", run: () => { void write(url, "PATCH", ceilingBody(unit, before)).then(({ error: no }) => { if (no) toast(no); void read(); }); } });
  };
  /* The ceiling's button and field on a token that can generate, for an admin. */
  const ceilingEdit = (t: ApiToken) => {
    if (!admin || !unit || t.scope !== "render") return null;
    const current = unit === "credits" ? t.capCredits : t.capUsd;
    return { button: <Btn disabled={busy != null} pressed={edit?.id === t.id} onClick={() => { setEdit(edit?.id === t.id ? null : { id: t.id, value: current == null ? "" : String(current) }); setNote(null); }} testId="settings-token-ceiling">{current == null ? "Set ceiling" : "Ceiling"}</Btn>,
      form: edit?.id === t.id ? (
        <form className="gs-capform" onSubmit={(e) => { e.preventDefault(); void saveCeiling(t); }} data-testid="settings-token-ceiling-edit">
          <label className="gs-label"><span className="gs-eyebrow">{unit === "credits" ? "Monthly ceiling (cr), empty for none" : "Monthly ceiling ($), empty for none"}</span>
            <input className="gs-field" inputMode={unit === "credits" ? "numeric" : "decimal"} value={edit.value} autoFocus onChange={(e) => setEdit({ id: t.id, value: e.target.value })} data-testid="settings-token-ceiling-field" />
          </label>
          <button type="submit" className="gs-btn" data-hot disabled={busy != null} data-testid="settings-token-ceiling-save">{busy === t.id ? "Saving…" : "Save ceiling"}</button>
        </form>
      ) : null };
  };
  const copy = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh.token); setCopied(true); toast("Copied · shown once"); } catch { toast("Copy didn’t work here. Select the token and copy it."); }
  };

  return (
    <Section label="MCP for outside agents" meta="Particl is an MCP server · tokens you control" testId="settings-tokens"
      action={dialog ? undefined : <button type="button" className="gs-primary" disabled={!unit} onClick={() => { setDialog("new"); setNote(null); }} data-testid="settings-token-make">Make a token</button>}>
      {error ? <Problem text={error} onRetry={() => void read()} testId="settings-tokens-error" /> : !data ? <Row name="Reading your tokens…" /> : null}
      {data && !parsed ? <Problem text="Your tokens could not be read." onRetry={() => void read()} /> : null}
      {parsed && !tokens.length ? <Row name="No tokens yet." line="Make one for an outside agent; it prepares jobs, and a person approves each." testId="settings-tokens-empty" /> : null}
      {tokens.map((t) => {
        const cap = ceilingEdit(t);
        return (
          <div key={t.id}>
            <Row name={t.name} line={unit ? tokenLine(t, unit) : undefined} value={tokenValue(t)} testId="settings-token">
              {confirming === t.id ? (
                <>
                  <Btn danger disabled={busy != null} onClick={() => void revoke(t)} testId="settings-token-revoke-confirm">{busy === t.id ? "Revoking…" : "Revoke now"}</Btn>
                  <Btn disabled={busy != null} onClick={() => setConfirming(null)} testId="settings-token-keep">Keep</Btn>
                </>
              ) : <>{cap?.button}<Btn disabled={busy != null} onClick={() => { setConfirming(t.id); setNote(null); }} testId="settings-token-revoke">Revoke</Btn></>}
            </Row>
            {cap?.form}
          </div>
        );
      })}
      {/* An admin's view of the other members' tokens that can generate: their ceilings, never their secrets; revoking stays their maker's. */}
      {others.length ? <Row name="Members’ tokens that can generate" line="Each spends only inside the ceiling you set" testId="settings-tokens-others" /> : null}
      {others.map((t) => {
        const cap = ceilingEdit(t);
        return (
          <div key={t.id}>
            <Row name={t.name} line={[t.owner ? `${t.owner}’s` : null, unit ? tokenLine(t, unit) : null].filter(Boolean).join(" · ")} value={tokenValue(t)} testId="settings-token-other">{cap?.button}</Row>
            {cap?.form}
          </div>
        );
      })}
      <Prepared />
      {note && !dialog ? <Note ok={note.ok} text={note.text} testId="settings-tokens-note" /> : null}
      {dialog === "new" ? (
        <TokenDialog title="New token for an outside agent" sub="MCP · the agent prepares jobs; a person approves each one" onClose={close} testId="settings-token-form">
          <form className="gsec-form" onSubmit={(e) => { e.preventDefault(); void make(); }}>
            <label className="gsec-field"><span className="gsec-eyebrow">Name</span>
              <input className="gsec-input" value={name} maxLength={60} autoFocus placeholder="What the agent is, e.g. a script on the studio Mac" autoComplete="off" onChange={(e) => { setName(e.target.value); setNote(null); }} data-testid="settings-token-name" />
            </label>
            <div className="gsec-field" role="radiogroup" aria-label="What it can do">
              <span className="gsec-eyebrow">Can</span>
              <div className="gsec-chips">
                <button type="button" role="radio" aria-checked={scope === "read"} className="gsec-chip" aria-pressed={scope === "read"} onClick={() => setScope("read")} data-testid="settings-token-scope-read">{scope === "read" ? "✓ " : ""}Read only</button>
                <button type="button" role="radio" aria-checked={scope === "prepare"} className="gsec-chip" aria-pressed={scope === "prepare"} onClick={() => setScope("prepare")} data-testid="settings-token-scope-prepare">{scope === "prepare" ? "✓ " : ""}Prepare jobs</button>
                {admin ? <button type="button" role="radio" aria-checked={scope === "render"} className="gsec-chip" aria-pressed={scope === "render"} onClick={() => { setScope("render"); if (!ceiling && unit) setCeiling(DEFAULT_CEILING[unit]); }} data-testid="settings-token-scope-render">{scope === "render" ? "✓ " : ""}Can generate</button> : null}
              </div>
              <span className="gsec-sub" data-testid="settings-token-scope-note">{scope === "read"
                ? "Lists and fetches takes; every write is refused."
                : scope === "render"
                  ? "Starts a job only with the price it was given, up to this ceiling a month. Empty: it only prepares and prices."
                  : "Prepares jobs and spends nothing itself. Each job waits here until a person opens it in Make, sees its price and approves it."}</span>
            </div>
            {scope === "render" && unit ? (
              <label className="gsec-field"><span className="gsec-eyebrow">{unit === "credits" ? "Monthly ceiling (cr)" : "Monthly ceiling ($)"}</span>
                <input className="gsec-input" inputMode={unit === "credits" ? "numeric" : "decimal"} value={ceiling} autoComplete="off" onChange={(e) => { setCeiling(e.target.value); setNote(null); }} data-testid="settings-token-ceiling-new" />
              </label>
            ) : null}
            {note ? <p className="gsec-problem" role="alert" data-testid="settings-tokens-note">{note.text}</p> : null}
            <div className="gsec-acts">
              <button type="button" className="gsec-btn" onClick={close} data-testid="settings-token-cancel">Cancel</button>
              <button type="submit" className="gsec-btn gsec-primary" disabled={busy != null || !name.trim()} data-testid="settings-token-create">{busy === "make" ? "Making…" : "Create token"}</button>
            </div>
          </form>
        </TokenDialog>
      ) : null}
      {dialog === "shown" && fresh ? (
        <TokenDialog title="Token created" sub={`${fresh.scope === "read" ? "Read only" : fresh.scope === "render" ? "Generates within its ceiling" : "Prepare jobs"} · revoke it any time in Connections`} onClose={() => setDialog(null)} testId="settings-token-fresh">
          <div className="gsec-form">
            <div className="gsec-field">
              <span className="gsec-eyebrow">Token · shown once</span>
              <code className="gsec-link-url" data-testid="settings-token-secret">{fresh.token}</code>
              <span className="gsec-sub">Copy it now. Particl keeps only a fingerprint; you won’t see it again. The setup below has it filled in.</span>
            </div>
            <div className="gsec-acts">
              <button type="button" className="gsec-btn" disabled={busy != null} onClick={() => void revoke(fresh)} data-testid="settings-token-fresh-revoke">Revoke</button>
              <button type="button" className="gsec-btn" onClick={() => setDialog(null)} data-testid="settings-token-done">Done</button>
              <button type="button" className="gsec-btn gsec-primary" autoFocus onClick={() => void copy()} data-testid="settings-token-copy">{copied ? "Copied" : "Copy token"}</button>
            </div>
          </div>
        </TokenDialog>
      ) : null}
    </Section>
  );
}

/** The design's settings dialog (Gaps B, "token=new" and "token=shown"): over a scrim, Escape closes it. */
function TokenDialog({ title, sub, onClose, testId, children }: { title: string; sub: string; onClose: () => void; testId: string; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="gsec-layer" data-testid={testId}>
      <div className="gsec-scrim" onClick={onClose} aria-hidden="true" />
      <div className="gsec-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`}>
        <div className="gsec-head gsec-head-gap">
          <strong className="gsec-title" id={`${testId}-title`}>{title}</strong>
          <span className="gsec-sub">{sub}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * What outside agents prepared (lib/security/prepared-jobs.ts): each waits for a person. Open in Make hands its
 * words and settings to Make, which shows the price; pressing Make there is the approval. Dismiss marks it, and
 * nothing is erased. Nothing here spends.
 */
function Prepared() {
  const shell = useShell();
  const compact = useCompact();
  const router = useRouter();
  const write = useWrite();
  const { toast } = useWorkspace();
  const { data, read } = useRead<{ jobs: PreparedJob[] }>("/api/prepared-jobs");
  const jobs = data?.jobs ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  if (!jobs.length) return null;
  const decide = async (job: PreparedJob, state: "opened" | "dismissed") => {
    setBusy(job.id);
    const { error: refused } = await write(`/api/prepared-jobs/${encodeURIComponent(job.id)}`, "PATCH", { state });
    setBusy(null);
    if (refused) { toast(refused); return; }
    void read();
    if (state === "opened") {
      const preset = { prompt: job.prompt, type: "video" as const, model: preparedModelId(job.model), note: `Prepared by ${job.tokenName ?? "an outside agent"}`,
        picks: { duration: job.duration, resolution: job.resolution, ratio: job.ratio, generateAudio: job.audio } };
      /* A phone has its own Make screen (DECISIONS 11): the words wait for it, and it opens on them. */
      if (compact) { stashGenPreset(preset); router.push("/suites?screen=make"); }
      else shell.openMake(preset);
    } else toast("Dismissed · nothing was spent");
  };
  return (
    <div data-testid="settings-prepared">
      <Row name="Waiting for a person" line={`${jobs.length} prepared by outside agents · each is priced in Make when you open it`} />
      {jobs.map((job) => (
        <Row key={job.id} name={job.prompt.length > 90 ? `${job.prompt.slice(0, 89)}…` : job.prompt} line={[preparedSpec(job), job.project, `from ${job.tokenName ?? "a revoked token"}`].filter(Boolean).join(" · ")} testId="settings-prepared-job">
          <Btn disabled={busy != null} onClick={() => void decide(job, "dismissed")} testId="settings-prepared-dismiss">Dismiss</Btn>
          {job.engine ? null : <Btn disabled={busy != null} onClick={() => void decide(job, "opened")} testId="settings-prepared-open">Open in Make</Btn>}
        </Row>
      ))}
    </div>
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
      {tools.map((t) => <Row key={t.name} name={<span className="gs-mono">{t.name}</span>} line={t.line} value={t.token === "any" ? "Any token" : t.token === "prepare" ? "Prepare jobs" : "Can generate"} testId="settings-mcp-tool" />)}
    </Folded>
  );
}
