"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";
import { ManagementCard, ManagementNotice } from "./ManagementPage";

type KeyState = { mode: string; keyring: boolean; keys: { name: string; set: boolean; masked: string | null }[] };
type CheckProblem = 'no_ready_identity' | 'authentication_rejected' | 'rate_limited' | 'model_unavailable' | 'invalid_response' | 'provider_unavailable' | 'mock_mode';
type Estimate = { status: 'quoted' | 'skipped' | 'unavailable'; usd?: number; error?: CheckProblem };
type Verification = {
  configured: boolean;
  auth: 'verified' | 'rejected' | 'unavailable' | 'not_configured' | 'mock';
  readyIdentityAvailable: boolean;
  error: Exclude<CheckProblem, 'no_ready_identity' | 'model_unavailable'> | 'missing_configuration' | null;
  estimates: { '720p': Estimate; '1080p': Estimate };
};
const authLabels: Record<Verification['auth'], string> = {
  verified: 'Authentication verified', rejected: 'Authentication rejected',
  unavailable: 'Authentication could not be checked', not_configured: 'No Higgsfield connection configured',
  mock: 'Local mock mode — provider not contacted',
};
const problemLabels: Record<CheckProblem | 'missing_configuration', string> = {
  missing_configuration: 'Save a workspace connection or ask the platform operator to configure Higgsfield.',
  authentication_rejected: 'Higgsfield did not accept the saved credentials.',
  rate_limited: 'The check was rate limited. Try again later.',
  provider_unavailable: 'Higgsfield is temporarily unavailable. Try again later.',
  invalid_response: 'Higgsfield did not return a usable verification response.',
  model_unavailable: 'The Soul character estimate is not available for this connection.',
  no_ready_identity: 'No ready Soul identity was found in the first results page.',
  mock_mode: 'No provider request was made in this local mock environment.',
};
function validVerification(value: unknown): value is Verification {
  if (!value || typeof value !== 'object') return false;
  const result = value as Verification;
  return typeof result.configured === 'boolean' && typeof result.readyIdentityAvailable === 'boolean'
    && Object.hasOwn(authLabels, result.auth) && (result.error === null || Object.hasOwn(problemLabels, result.error))
    && ['720p', '1080p'].every(resolution => {
    const estimate = result.estimates?.[resolution as keyof Verification['estimates']];
    return estimate && ['quoted', 'skipped', 'unavailable'].includes(estimate.status)
      && (estimate.error === undefined || Object.hasOwn(problemLabels, estimate.error))
      && (estimate.status !== 'quoted' || (typeof estimate.usd === 'number' && Number.isFinite(estimate.usd) && estimate.usd > 0));
  });
}

/** Secrets only travel once to the owner's encrypted connection endpoint. */
export default function HiggsfieldConnection() {
  const { requestScope } = useSession();
  const { data, error, refresh } = useApi<KeyState>("/api/workspaces/keys", 0, requestScope);
  const scopedFetch = useScopedFetch();
  const [keyId, setKeyId] = useState(""), [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<'save' | 'verify' | null>(null), [message, setMessage] = useState("");
  const [verification, setVerification] = useState<Verification | null>(null), [verificationError, setVerificationError] = useState('');
  const active = useRef(true), inFlight = useRef(false), revision = useRef(0);
  useEffect(() => {
    const currentRevision = revision;
    active.current = true;
    return () => { active.current = false; currentRevision.current++; };
  }, []);
  const key = data?.keys.find(item => item.name === "higgsfield");
  const edited = !!(keyId || secret);
  const canVerify = data?.mode === 'legacy' || !!key?.set;

  function invalidateCheck() {
    revision.current++; setVerification(null); setVerificationError(''); setMessage('');
  }

  async function save() {
    if (inFlight.current || !keyId.trim() || !secret.trim()) return;
    inFlight.current = true; invalidateCheck(); setBusy('save');
    try {
      const response = await scopedFetch("/api/workspaces/keys", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "higgsfield", value: `${keyId.trim()}:${secret.trim()}` }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The connection could not be saved.");
      if (!active.current) return;
      setKeyId(""); setSecret(""); refresh();
      setMessage("Higgsfield connection saved. Open Characters or Elements in Studio to create a Soul ID.");
    } catch (cause) { if (active.current) setMessage(cause instanceof Error ? cause.message : "The connection could not be saved."); }
    finally { inFlight.current = false; if (active.current) setBusy(null); }
  }

  async function verify() {
    if (inFlight.current || edited || !data || !canVerify) return;
    inFlight.current = true; invalidateCheck(); const attempt = revision.current; setBusy('verify');
    try {
      const response = await scopedFetch('/api/workspaces/keys/higgsfield/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'The connection check could not be completed. Try again.');
      if (!validVerification(result)) throw new Error('The connection check returned an unreadable result. Try again.');
      if (active.current && revision.current === attempt) setVerification(result);
    } catch (cause) {
      if (active.current && revision.current === attempt) setVerificationError(cause instanceof Error ? cause.message : 'The connection check could not be completed. Try again.');
    } finally { inFlight.current = false; if (active.current) setBusy(null); }
  }

  return <ManagementCard title="Higgsfield · Soul ID" description="Create reusable character likenesses from portrait references. Your workspace key is encrypted and only its masked ending is returned.">
    {!data ? <p role="status">{error ? "Connection settings could not be loaded." : "Loading connection…"}</p>
      : data.mode === "legacy" ? <p>This workspace uses the platform’s Higgsfield connection. The platform operator can configure it in the deployment’s private environment.</p>
      : !data.keyring ? <p>Ask the platform operator to enable encrypted workspace connections.</p>
      : <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-4">
        <p className="text-sm text-mute">{key?.set ? `Workspace connection saved · ${key.masked}` : "Add the API key ID and secret from your Higgsfield console."}</p>
        {key?.set && <p className="text-sm text-mute">Existing Soul identities stay tied to this connection. Changing it pauses their use until the original connection is restored.</p>}
        <label className="management-field">Higgsfield API key ID<input aria-label="Higgsfield API key ID" autoComplete="off" spellCheck={false} value={keyId} onChange={event => { invalidateCheck(); setKeyId(event.target.value); }} disabled={!!busy} /></label>
        <label className="management-field">Higgsfield API key secret<input aria-label="Higgsfield API key secret" type="password" autoComplete="new-password" value={secret} onChange={event => { invalidateCheck(); setSecret(event.target.value); }} disabled={!!busy} /></label>
        <button className="management-button primary" type="submit" disabled={!!busy || !keyId.trim() || !secret.trim()}>{busy === 'save' ? "Saving…" : "Save Higgsfield connection"}</button>
      </form>}
    {message && <p role="status">{message}</p>}
    {data && <div className="mt-5 space-y-3">
      <p className="text-sm text-mute">Check the saved connection and available Soul character price estimates. No training or generation credits are spent.</p>
      <button className="management-button" type="button" disabled={!!busy || edited || !canVerify} onClick={() => void verify()}>{busy === 'verify' ? 'Verifying connection…' : 'Verify connection'}</button>
      {!canVerify && <p className="text-sm text-mute">Save your own Higgsfield connection to verify it.</p>}
      {edited && <p className="text-sm text-mute">Save or clear your credential edits before checking the saved connection.</p>}
      {verificationError && <ManagementNotice error>{verificationError}</ManagementNotice>}
      {verification && <ManagementNotice error={verification.auth === 'rejected' || verification.auth === 'unavailable' || verification.auth === 'not_configured'}>
        <div className="space-y-2" aria-label="Higgsfield verification result">
          <p><strong>{authLabels[verification.auth]}</strong></p>
          {verification.error && <p>{problemLabels[verification.error]}</p>}
          {(['720p','1080p'] as const).map(resolution => {
            const estimate = verification.estimates[resolution];
            return <p key={resolution}><strong>{resolution}:</strong> {estimate.status === 'quoted' ? `$${estimate.usd!.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} estimate` : `${estimate.status === 'skipped' ? 'Not checked' : 'Estimate unavailable'} — ${estimate.error ? problemLabels[estimate.error] : 'No estimate was returned.'}`}</p>;
          })}
          <p>No training or generation was started. This check does not enable the rendering model.</p>
        </div>
      </ManagementNotice>}
    </div>}
  </ManagementCard>;
}
