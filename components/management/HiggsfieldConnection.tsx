"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ManagementCard } from "./ManagementPage";

type KeyState = { mode: string; keyring: boolean; keys: { name: string; set: boolean; masked: string | null }[] };

/** Secrets only travel once to the owner's encrypted connection endpoint. */
export default function HiggsfieldConnection() {
  const { data, error, refresh } = useApi<KeyState>("/api/workspaces/keys");
  const scopedFetch = useScopedFetch();
  const [keyId, setKeyId] = useState(""), [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const key = data?.keys.find(item => item.name === "higgsfield");

  async function save() {
    if (busy || !keyId.trim() || !secret.trim()) return;
    setBusy(true); setMessage("");
    try {
      const response = await scopedFetch("/api/workspaces/keys", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "higgsfield", value: `${keyId.trim()}:${secret.trim()}` }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The connection could not be saved.");
      setKeyId(""); setSecret(""); refresh();
      setMessage("Higgsfield connection saved. Open Characters or Elements in Studio to create a Soul ID.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "The connection could not be saved."); }
    finally { setBusy(false); }
  }

  return <ManagementCard title="Higgsfield · Soul ID" description="Create reusable character likenesses from portrait references. Your workspace key is encrypted and only its masked ending is returned.">
    {!data ? <p role="status">{error ? "Connection settings could not be loaded." : "Loading connection…"}</p>
      : data.mode === "legacy" ? <p>This workspace uses the platform’s Higgsfield connection. The platform operator can configure it in the deployment’s private environment.</p>
      : !data.keyring ? <p>Ask the platform operator to enable encrypted workspace connections.</p>
      : <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-4">
        <p className="text-sm text-mute">{key?.set ? `Workspace connection saved · ${key.masked}` : "Add the API key ID and secret from your Higgsfield console."}</p>
        {key?.set && <p className="text-sm text-mute">Existing Soul identities stay tied to this connection. Changing it pauses their use until the original connection is restored.</p>}
        <label className="management-field">Higgsfield API key ID<input aria-label="Higgsfield API key ID" autoComplete="off" spellCheck={false} value={keyId} onChange={event => setKeyId(event.target.value)} disabled={busy} /></label>
        <label className="management-field">Higgsfield API key secret<input aria-label="Higgsfield API key secret" type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} disabled={busy} /></label>
        <button className="management-button primary" type="submit" disabled={busy || !keyId.trim() || !secret.trim()}>{busy ? "Saving…" : "Save Higgsfield connection"}</button>
      </form>}
    {message && <p role="status">{message}</p>}
  </ManagementCard>;
}
