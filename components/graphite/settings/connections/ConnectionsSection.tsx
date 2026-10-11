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
import { CLIENTS, mcpEndpoint, mcpTools, parseTokens, setupGuide, tokenBody, type ApiToken, type ClientId, type TokenUnit } from "@/lib/shell/tools-connections";
import type { SettingsFold } from "@/lib/shell/settings";
import { Btn, CopyBlock, Folded, Note, Problem, Row, Section } from "../parts";
import { PUBLISHING_ACCOUNTS, tokenLine, tokenValue } from "../model";
import { useRead, useWrite } from "../use-settings";

/**
 * Settings › Connections (README § 3.5, § 4 "MCP tokens"): Particl as an MCP server, and the tokens that reach it.
 * The rows are the person's own tokens (GET /api/tokens). Revoking disables a token at once and erases nothing.
 * A token's secret is shown once, in the "Token created" dialog (Gaps B), and never stored. A new token reads, or
 * prepares jobs that wait here for a person (owner rule: agents and MCP tokens prepare only); neither spends. An
 * older "Can generate" token still starts takes inside the ceiling a person set, and says so.
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
  const { data, error, read } = useRead<unknown>("/api/tokens");
  const parsed = data ? parseTokens(data) : null;
  const unit: TokenUnit | null = parsed?.unit ?? null;
  const tokens: ApiToken[] = parsed?.tokens ?? [];
  const [dialog, setDialog] = useState<"new" | "shown" | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"prepare" | "read">("prepare");
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
    pressing.current = true; setBusy("make"); setNote(null);
    const { json, error: refused } = await write<{ id?: string; name?: string; scope?: string; token?: string }>("/api/tokens", "POST", tokenBody(trimmed, scope, unit, null));
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
              </div>
              <span className="gsec-sub" data-testid="settings-token-scope-note">{scope === "read"
                ? "Lists and fetches takes; every write is refused."
                : "Prepares jobs and spends nothing itself. Each job waits here until a person opens it in Make, sees its price and approves it."}</span>
            </div>
            {note ? <p className="gsec-problem" role="alert" data-testid="settings-tokens-note">{note.text}</p> : null}
            <div className="gsec-acts">
              <button type="button" className="gsec-btn" onClick={close} data-testid="settings-token-cancel">Cancel</button>
              <button type="submit" className="gsec-btn gsec-primary" disabled={busy != null || !name.trim()} data-testid="settings-token-create">{busy === "make" ? "Making…" : "Create token"}</button>
            </div>
          </form>
        </TokenDialog>
      ) : null}
      {dialog === "shown" && fresh ? (
        <TokenDialog title="Token created" sub={`${fresh.scope === "read" ? "Read only" : "Prepare jobs"} · revoke it any time in Connections`} onClose={() => setDialog(null)} testId="settings-token-fresh">
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
          <Btn disabled={busy != null} onClick={() => void decide(job, "opened")} testId="settings-prepared-open">Open in Make</Btn>
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
