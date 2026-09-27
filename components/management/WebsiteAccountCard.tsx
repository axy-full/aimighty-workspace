"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { timeAgo } from "@/lib/format";
import { appConfirm } from "@/components/dialog";

/**
 * Platform desk › Website tools account: which connected account runs the
 * website-only tools for every managed workspace, whether it can take new
 * work, and which tools are on. The server answers with no token, account
 * identifier, wallet, balance or price; the rate is reported as set or not.
 */
type Tool = { id: string; label: string; pricing: "get_cost" | "fixed"; enabled: boolean; priceSet: boolean };
type Status = {
  state: "unset" | "ready" | "paused" | "unavailable";
  reason: string | null;
  designatedAt: number | null;
  pausedAt: number | null;
  host: { workspaceName: string | null; yours: boolean } | null;
  candidate: { eligible: boolean; reason: string | null } | null;
  rateSet: boolean;
  tools: Tool[];
};
const STATE: Record<Status["state"], string> = { unset: "Not designated", ready: "Ready", paused: "Paused", unavailable: "Needs attention" };

export function WebsiteAccountCard() {
  const { requestScope } = useSession();
  const { data, error, refresh } = useApi<Status>("/api/admin/website-account", 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const status = data;

  async function post(key: string, body: Record<string, unknown>) {
    if (!requestScope) { setProblem("Reload this page in the intended account and workspace first."); return; }
    setBusy(key); setProblem(null);
    try {
      const send = (extra: Record<string, unknown> = {}) => fetch("/api/admin/website-account", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": requestScope }, body: JSON.stringify({ ...body, ...extra }),
      });
      let res = await send();
      let json = await res.json().catch(() => ({})) as { error?: string; code?: string };
      // Jobs still running on the current account: said once, then confirmed by the person.
      if (res.status === 409 && json.code === "jobs_in_flight" && await appConfirm("Jobs are still running", json.error, { confirmLabel: "Continue", danger: true })) {
        res = await send({ acknowledge: true });
        json = await res.json().catch(() => ({})) as { error?: string; code?: string };
      } else if (res.status === 409 && json.code === "jobs_in_flight") return;
      if (!res.ok) throw new Error(json.error ?? `The server answered ${res.status}.`);
      await refresh();
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(null); }
  }
  async function designate() {
    if (status?.host && !status.host.yours && !(await appConfirm("Move the website tools account here?", "New work runs through this workspace's connection from now on, with every tool off until you switch it on.", { confirmLabel: "Move" }))) return;
    await post("designate", { action: "designate" });
  }
  async function release() {
    if (!(await appConfirm("Release the website tools account?", "Website tools stop taking new work for every workspace. Jobs already running keep collecting.", { confirmLabel: "Release", danger: true }))) return;
    await post("release", { action: "release" });
  }
  function toggle(tool: Tool) {
    const on = new Set(status!.tools.filter((t) => t.enabled).map((t) => t.id));
    if (tool.enabled) on.delete(tool.id); else on.add(tool.id);
    void post(`tool:${tool.id}`, { action: "tools", tools: [...on] });
  }

  if (!status) return error ? (
    <section className="scard wacct" data-testid="website-account">
      <div className="scard-h"><span>Website tools account</span></div>
      <p className="wacct-problem" role="alert">{error} <button type="button" className="chip" onClick={() => void refresh()}>Try again</button></p>
    </section>
  ) : null;
  const designated = status.state !== "unset";
  return (
    <section className="scard wacct" data-testid="website-account">
      <div className="scard-h"><span>Website tools account</span><span>The connected account that runs website-only tools for every managed workspace. Clients pay Particl credits; a tool runs only when it is on and priced.</span></div>
      <div className="wacct-state">
        <span className="wacct-pill" data-state={status.state} data-testid="website-account-state">{STATE[status.state]}</span>
        {status.host ? <span className="wacct-meta">{status.host.workspaceName ?? "A workspace"}{status.host.yours ? " · this workspace" : ""}{status.designatedAt ? ` · since ${timeAgo(status.designatedAt)}` : ""}</span> : null}
        <span className="wacct-meta" data-testid="website-account-rate">{status.rateSet ? "Credit rate set" : "Credit rate not set"}</span>
      </div>
      {status.reason ? <p className="wacct-reason" role="status">{status.reason}</p> : null}
      <div className="wacct-actions">
        {status.candidate && !status.host?.yours ? (
          <button type="button" className="btn-primary" disabled={busy != null || !status.candidate.eligible} onClick={() => void designate()} data-testid="website-account-designate">
            {busy === "designate" ? "Designating…" : designated ? "Move here" : "Use this workspace's connection"}
          </button>
        ) : null}
        {designated ? (
          <>
            <button type="button" className="chip" disabled={busy != null} onClick={() => void post("pause", { action: status.pausedAt ? "resume" : "pause" })} data-testid="website-account-pause">
              {busy === "pause" ? "Saving…" : status.pausedAt ? "Resume" : "Pause"}
            </button>
            <button type="button" className="chip" disabled={busy != null} onClick={() => void release()} data-testid="website-account-release">{busy === "release" ? "Releasing…" : "Release"}</button>
          </>
        ) : null}
      </div>
      {status.candidate && !status.candidate.eligible && !status.host?.yours ? <p className="wacct-meta">{status.candidate.reason}</p> : null}
      {designated ? (
        <div className="wacct-tools" role="group" aria-label="Tools clients may run">
          {status.tools.map((tool) => (
            <button key={tool.id} type="button" className={`wacct-tool${tool.enabled ? " is-on" : ""}`} aria-pressed={tool.enabled}
              disabled={busy != null || (!tool.enabled && !tool.priceSet)} onClick={() => toggle(tool)} data-testid={`website-tool-${tool.id}`}>
              <span className="wacct-tool-name">{tool.label}</span>
              <span className="wacct-tool-note">{tool.enabled ? "On" : tool.priceSet ? "Off" : "Needs a price"}</span>
            </button>
          ))}
        </div>
      ) : null}
      {problem ? <p className="wacct-problem" role="alert">{problem}</p> : null}
    </section>
  );
}
