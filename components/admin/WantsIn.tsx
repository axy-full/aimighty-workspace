"use client";

import { useState, type FormEvent } from "react";
import { timeAgo } from "@/lib/format";
import { useMoney } from "@/lib/price";
import { usePhone } from "@/lib/usePhone";
import { Button, Mono } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { appConfirm } from "@/components/dialog";
import { Card, ROW, Nothing, TextAction, FIELD, FIELD_LABEL } from "./Card";
import { call } from "./api";
import { grantBudgetRoom, sendLabel } from "./adminFormat";
import type { Admin, QueueRow } from "./types";

/**
 * Wants in (SOW surfaces board 12h, block 1): who asked, newest first, one
 * 48px row each — who at 500, what they said in `--ink-muted`, when, and
 * `Skip`; the codes already out, with `Withdraw`. The screen's one filled
 * primary is `Send N codes · <grant> EACH`: one code per open request, in
 * one call, the grant read from the platform (never typed here), refused
 * by the server when the cycle's grant budget would be passed — the desk
 * shows that sentence and nothing is issued. `Invite by email` is the v1
 * lever, kept as a secondary that opens the small form. Neither sends
 * while the deployment cannot provision a workspace (`ready`), and the
 * primary is outlined — never filled — when there is nobody to send to,
 * when the budget will not take the codes, or while a sheet is open.
 */
export function queueOf(data: Admin): QueueRow[] {
  if (data.queue) return data.queue;
  /* A route a version behind: build the queue the way the contract does — open requests, then codes out, newest first. */
  const requests = [...data.requests].sort((a, b) => b.createdAt - a.createdAt).map((r): QueueRow => ({
    id: r.id, kind: "request", who: r.name || r.email, email: r.email, what: r.note || "asked to be let in", when: r.createdAt, code: null, expiresAt: null,
  }));
  const invites = [...data.invites].sort((a, b) => b.createdAt - a.createdAt).map((i): QueueRow => ({
    id: i.code, kind: "invite", who: i.name || i.email, email: i.email, what: i.sentAt ? `code sent` : "code not sent", when: i.createdAt, code: i.code, expiresAt: i.expiresAt,
  }));
  return [...requests, ...invites];
}

/** The primary's state and its one action, shared by the card head (desk) and the pinned block (phone). */
export function useSendCodes(data: Admin, onChanged: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const queue = queueOf(data);
  const requests = queue.filter((r) => r.kind === "request");
  const n = requests.length;
  const grant = data.grant ?? { credits: data.signupCredits, usdEach: data.signupCredits * data.creditUsd, days: null as number | null };
  /* The budget's room by the lib's rule (§7A guardrail 1): what the cycle has granted plus what the open codes will grant, against the ceiling. */
  const fits = grantBudgetRoom({
    budgetUsd: data.totals?.grantBudgetUsd ?? null, grantedUsd: data.totals?.grantsUsd ?? 0, committedUsd: data.totals?.committedUsd ?? 0,
    grantCredits: grant.credits, usdEach: grant.usdEach,
  }, n);
  async function send() {
    if (n === 0 || busy || !data.ready) return;
    setBusy(true);
    try {
      const j = await call<{ issued?: { code: string; link: string; email: string; name: string; sent: boolean; mailError: string | null }[] }>(
        "/api/admin/invites", "POST", { requestIds: requests.map((r) => r.id) });
      const issued = j.issued ?? [];
      const unsent = issued.filter((i) => !i.sent).length;
      toast(`${issued.length} ${issued.length === 1 ? "code" : "codes"} issued${unsent ? ` · ${unsent} not emailed` : ""}`);
      onChanged();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  }
  return { queue, n, grant, fits, busy, send, label: sendLabel(n) };
}

export default function WantsIn({ data, onChanged, codes, sheetOpen = false }: { data: Admin; onChanged: () => void; codes: ReturnType<typeof useSendCodes>; sheetOpen?: boolean }) {
  const phone = usePhone();
  const toast = useToast();
  const money = useMoney();
  const [form, setForm] = useState<{ open: boolean; email: string; name: string; note: string; busy: boolean; last: { link: string; sent: boolean; mailError: string | null } | null }>({ open: false, email: "", name: "", note: "", busy: false, last: null });
  const { queue, n, grant, fits, busy, send, label } = codes;

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!form.email || form.busy) return;
    setForm({ ...form, busy: true });
    try {
      const j = await call<{ link: string; sent: boolean; mailError: string | null }>("/api/admin/invites", "POST", { email: form.email, name: form.name, note: form.note, send: true });
      setForm({ open: true, email: "", name: "", note: "", busy: false, last: { link: j.link, sent: j.sent, mailError: j.mailError } });
      toast(j.sent ? `${form.name || form.email} invited` : "Code made · not emailed");
      onChanged();
    } catch (err) { toast((err as Error).message); setForm({ ...form, busy: false }); }
  }
  async function skip(r: QueueRow) {
    try {
      if (r.kind === "invite") {
        if (!(await appConfirm("Withdraw this code?", "The link stops working.", { confirmLabel: "Withdraw", danger: true }))) return;
        await call(`/api/admin/invites/${encodeURIComponent(r.id)}`, "DELETE");
        toast("Code withdrawn");
      } else {
        await call(`/api/admin/requests/${encodeURIComponent(r.id)}`, "PATCH");
        toast(`${r.who} skipped`);
      }
      onChanged();
    } catch (e) { toast((e as Error).message); }
  }

  /* The cost on the button is the grant in the desk's own unit: credits where the desk's workspace pays in credits, the grant's dollar cost where it pays at cost. */
  const cost = money.inCredits ? grant.credits : grant.usdEach;
  const primary = (
    <Button variant="primary" placement="desk" cost={cost} costSuffix=" each" outlined={!fits || n === 0 || sheetOpen} disabled={n === 0 || !data.ready} busy={busy} busyLabel="Sending" onClick={send} data-send-codes=""
      className="max-md:hidden">
      {label}
    </Button>
  );
  const line = grant.days != null ? `codes last ${grant.days} days` : "codes by email";

  return (
    <Card title="Wants in" line={line} label="Wants in"
      head={<>
        <Button variant="secondary" placement="desk" onClick={() => setForm({ ...form, open: !form.open })} aria-expanded={form.open}>Invite by email</Button>
        {primary}
      </>}>
      {form.open && (
        <form onSubmit={invite} className="flex flex-col gap-[10px] border-t border-[rgba(245,246,248,.07)] py-[12px]">
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)] gap-[10px] max-md:grid-cols-1">
            <label className={FIELD_LABEL}>Email<input className={FIELD} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className={FIELD_LABEL}>Name<input className={FIELD} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className={FIELD_LABEL}>Note<input className={FIELD} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="for your own record" /></label>
          </div>
          <span className="flex flex-wrap items-center gap-[10px]">
            <Button type="submit" variant="secondary" placement="desk" busy={form.busy} busyLabel="Inviting" disabled={!form.email || !data.ready}>Invite</Button>
            {!data.mail && <span className="text-[13px] leading-[1.4] text-ink-body">Email isn&rsquo;t set up here: copy the link and send it yourself.</span>}
          </span>
          {form.last && (
            <span className="break-all text-[13px] leading-[1.5] text-ink-body">
              {form.last.sent ? "Sent." : form.last.mailError ? `Not emailed (${form.last.mailError}).` : "Not emailed."} <span className="text-ink">{form.last.link}</span>
            </span>
          )}
        </form>
      )}
      {queue.length === 0 && <Nothing>Nobody waiting.</Nothing>}
      {queue.map((r) => (
        phone ? (
          <span key={`${r.kind}-${r.id}`} className={`${ROW} grid-cols-[minmax(0,1fr)_auto] gap-[12px] py-[8px]`}>
            <span className="flex min-w-0 flex-col gap-[5px]">
              <span className="truncate font-medium">{r.who} <span className="font-normal text-ink-muted">· {r.what}</span></span>
              <Mono cost>{timeAgo(r.when)}{r.kind === "invite" && r.expiresAt ? ` · ends ${timeAgo(r.expiresAt).replace(" ago", "")}` : ""}</Mono>
            </span>
            <TextAction onClick={() => skip(r)} label={`${r.kind === "invite" ? "Withdraw" : "Skip"} ${r.who}`}>{r.kind === "invite" ? "Withdraw" : "Skip"}</TextAction>
          </span>
        ) : (
          <span key={`${r.kind}-${r.id}`} className={`${ROW} grid-cols-[minmax(0,1fr)_150px_80px] gap-[12px]`}>
            <span className="truncate"><span className="font-medium">{r.who}</span> <span className="text-ink-muted">· {r.what}</span></span>
            <span className="truncate text-ink-muted">{timeAgo(r.when)}{r.kind === "invite" && r.expiresAt ? ` · ends in ${timeAgo(r.expiresAt).replace(" ago", "")}` : ""}</span>
            <TextAction onClick={() => skip(r)} className="justify-self-end text-right" label={`${r.kind === "invite" ? "Withdraw" : "Skip"} ${r.who}`}>{r.kind === "invite" ? "Withdraw" : "Skip"}</TextAction>
          </span>
        )
      ))}
      {!data.ready && <span className="pt-[10px] text-[13px] leading-[1.4] text-ink-body">Sign-up isn&rsquo;t open yet: set TURSO_API_TOKEN, TURSO_ORG and KEYRING_SECRET so a new workspace can be given a database and hold keys.</span>}
    </Card>
  );
}
