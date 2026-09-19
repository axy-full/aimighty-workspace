"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApi } from "@/lib/useApi";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";
import { ManagementCard, ManagementNotice } from "./ManagementPage";
import ConsumerVideoVerification from "./ConsumerVideoVerification";

type Connection = { connected: boolean; requiresReconnect: boolean; connectedAt?: number; expiresAt?: number };
type Discovery = { discoveryOnly: true; capabilitiesVerified: false; tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]; summary: Record<string, string[]>; protocolVersion: string };
type Qualification = { readOnly: true; results: { tool: string; arguments: Record<string, unknown>; result?: unknown; error?: unknown }[] };
const labels: Record<string, string> = { marketingVideo: "Marketing Video", brandExtraction: "Brand extraction", adReference: "Ad references", virality: "Virality Predictor", workspace: "Connected workspaces", uploads: "Media uploads", jobs: "Jobs and reports", pricing: "Pricing" };
const subscribeLocation = (notify: () => void) => { window.addEventListener("popstate", notify); return () => window.removeEventListener("popstate", notify); };
const connectionOutcome = () => new URL(window.location.href).searchParams.get("higgsfield") ?? "";

export default function HiggsfieldConsumerConnection() {
  const { requestScope } = useSession();
  const { data, error, refresh } = useApi<Connection>("/api/higgsfield/consumer/connection", 0, requestScope);
  const scopedFetch = useScopedFetch();
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const outcome = useSyncExternalStore(subscribeLocation, connectionOutcome, () => "");
  const [dismissedOutcome, setDismissedOutcome] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [qualification, setQualification] = useState<Qualification | null>(null);
  const [analysisQualification, setAnalysisQualification] = useState<Qualification | null>(null);
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function act(kind: "connect" | "discover" | "qualify" | "analysis" | "disconnect") {
    if (pending.current) return;
    pending.current = true; setBusy(kind); setProblem(""); setNotice(""); setDismissedOutcome(true);
    try {
      const response = await scopedFetch(`/api/higgsfield/consumer/${kind === "connect" ? "connect" : kind === "discover" ? "capabilities" : kind === "qualify" ? "qualification" : kind === "analysis" ? "analysis-qualification" : "connection"}`, { method: kind === "disconnect" ? "DELETE" : "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The connected account could not be updated.");
      if (!active.current) return;
      if (kind === "connect") {
        const url = new URL(result.url);
        if (url.origin !== "https://clerk.higgsfield.ai" || url.pathname !== "/oauth/authorize" || url.username || url.password) throw new Error("The connected account returned an unexpected sign-in address.");
        window.location.assign(url.href);
      } else if (kind === "discover") {
        if (result.discoveryOnly !== true || result.capabilitiesVerified !== false || !Array.isArray(result.tools) || !result.summary) throw new Error("The connected account did not return a usable workflow catalog.");
        setDiscovery(result); setNotice("Available tool definitions checked. No generation, upload or scoring was started.");
      } else if (kind === "qualify") {
        if (result.readOnly !== true || !Array.isArray(result.results)) throw new Error("The connected account did not return usable account capabilities.");
        setQualification(result); setNotice("Account options and available pricing checked. No workspace was switched and no paid job was started.");
      } else if (kind === "analysis") {
        if (result.readOnly !== true || result.scope !== "analysis-models" || !Array.isArray(result.results)) throw new Error("The connected account did not return usable analysis model definitions.");
        setAnalysisQualification(result); setNotice("Analysis model definitions checked. No video was uploaded and no scoring job was started.");
      } else {
        setDiscovery(null); setQualification(null); setAnalysisQualification(null); setNotice("Connected account removed from this Particl workspace."); await refresh();
      }
    } catch (reason) { if (active.current) setProblem(reason instanceof Error ? reason.message : "The account connection failed."); }
    finally { pending.current = false; if (active.current) setBusy(""); }
  }
  return <ManagementCard title="Connected video account" description="Connect your marketing account to discover its Marketing Video, brand, ad-reference and Virality Predictor tools. This is separate from the identity account key above.">
    <div className="p-5 space-y-4">
      <p className="text-sm text-mute">{data?.connected && !data.requiresReconnect ? "Account connected to this workspace owner." : data?.requiresReconnect ? "Reconnect your account to restore access." : "Sign in to the account to authorize Particl. You will see the permissions before you approve."}</p>
      <p className="text-xs text-dim leading-relaxed">The connection requests your profile, email and permission to retain access. Connecting and checking available tools do not start paid jobs. Media operations require a separate reviewed request.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="management-button primary" disabled={!!busy || !data} onClick={() => void act("connect")}>{busy === "connect" ? "Opening sign-in…" : data?.connected ? "Reconnect account" : "Connect account"}</button>
        {data?.connected && !data.requiresReconnect && <button type="button" className="management-button" disabled={!!busy} onClick={() => void act("discover")}>{busy === "discover" ? "Checking workflows…" : "Check available workflows"}</button>}
        {data?.connected && !data.requiresReconnect && <button type="button" className="management-button" disabled={!!busy} onClick={() => void act("qualify")}>{busy === "qualify" ? "Checking account options…" : "Check account options and pricing"}</button>}
        {data?.connected && !data.requiresReconnect && <button type="button" className="management-button" disabled={!!busy} onClick={() => void act("analysis")}>{busy === "analysis" ? "Checking analysis models…" : "Check analysis model definitions"}</button>}
        {(data?.connected || data?.requiresReconnect) && <button type="button" className="management-button" disabled={!!busy} onClick={() => void act("disconnect")}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect marketing account"}</button>}
        {error && <button type="button" className="management-button" disabled={!!busy} onClick={() => void refresh()}>Retry connection status</button>}
      </div>
      {(problem || error) && <ManagementNotice error>{problem || error}</ManagementNotice>}
      {!dismissedOutcome && outcome && <ManagementNotice error={outcome !== "connected"}>{outcome === "connected" ? "Account connected. Check available workflows to continue setup." : "The account connection was not completed. Sign in to the same Particl workspace and try connecting again."}</ManagementNotice>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {data?.connected && !data.requiresReconnect && <ConsumerVideoVerification key={requestScope ?? "signed-out"} />}
      {qualification && <details><summary className="cursor-pointer text-xs text-mute">Account capability diagnostics</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-3 text-[11px]" aria-label="Connected account capabilities">{JSON.stringify(qualification, null, 2)}</pre></details>}
      {analysisQualification && <details><summary className="cursor-pointer text-xs text-mute">Analysis model diagnostics</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-3 text-[11px]" aria-label="Connected analysis model definitions">{JSON.stringify(analysisQualification, null, 2)}</pre></details>}
      {discovery && <div className="space-y-3"><p className="text-sm">{discovery.tools.length} tools advertised by the connected account. Availability still needs workflow qualification.</p><dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{Object.entries(labels).map(([key, label]) => <div key={key} className="text-xs"><dt className="font-medium">{label}</dt><dd className="text-mute break-words">{discovery.summary[key]?.length ? `${discovery.summary[key].length} related tools found` : "No matching tool name found"}</dd></div>)}</dl><details><summary className="cursor-pointer text-xs text-mute">Connection diagnostics</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-3 text-[11px]" aria-label="Connected workflow definitions">{JSON.stringify({ protocolVersion: discovery.protocolVersion, tools: discovery.tools }, null, 2)}</pre></details></div>}
    </div>
  </ManagementCard>;
}
