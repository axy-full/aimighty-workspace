"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";
import { ManagementCard, ManagementNotice } from "./ManagementPage";

type KeyState = { mode: string; keyring: boolean; keys: { name: string; set: boolean; masked: string | null }[] };
type CheckProblem = 'no_ready_identity' | 'authentication_rejected' | 'rate_limited' | 'model_unavailable' | 'invalid_response' | 'provider_unavailable' | 'mock_mode';
type Estimate = { status: 'quoted' | 'skipped' | 'unavailable'; credits?: number; error?: CheckProblem };
type Verification = {
  configured: boolean;
  auth: 'verified' | 'rejected' | 'unavailable' | 'not_configured' | 'mock';
  readyIdentityAvailable: boolean;
  error: Exclude<CheckProblem, 'no_ready_identity' | 'model_unavailable'> | 'missing_configuration' | null;
  estimates: { '720p': Estimate; '1080p': Estimate };
};
const authLabels: Record<Verification['auth'], string> = {
  verified: 'Authentication verified', rejected: 'Authentication rejected',
  unavailable: 'Authentication could not be checked', not_configured: 'No identity account connected',
  mock: 'Local mock mode — provider not contacted',
};
const problemLabels: Record<CheckProblem | 'missing_configuration', string> = {
  missing_configuration: 'The identity engine is temporarily unavailable. Contact Particl support.',
  authentication_rejected: 'The identity account did not accept the saved credentials.',
  rate_limited: 'The check was rate limited. Try again later.',
  provider_unavailable: 'The identity account is temporarily unavailable. Try again later.',
  invalid_response: 'The identity account did not return a usable verification response.',
  model_unavailable: 'The identity render estimate is not available for this connection.',
  no_ready_identity: 'No ready identity was found in the first results page.',
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
      && (estimate.status !== 'quoted' || (typeof estimate.credits === 'number' && Number.isFinite(estimate.credits) && estimate.credits > 0));
  });
}

/** Shared engine status; only platform management can probe account-wide identities. */
export default function HiggsfieldConnection() {
  const { requestScope, superAdmin } = useSession();
  const { data, error } = useApi<KeyState>("/api/workspaces/keys", 0, requestScope);
  const scopedFetch = useScopedFetch();
  const [busy, setBusy] = useState<'verify' | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null), [verificationError, setVerificationError] = useState('');
  const active = useRef(true), inFlight = useRef(false), revision = useRef(0);
  useEffect(() => {
    const currentRevision = revision;
    active.current = true;
    return () => { active.current = false; currentRevision.current++; };
  }, []);
  const key = data?.keys.find(item => item.name === "higgsfield");
  const canVerify = superAdmin && !!key?.set;

  function invalidateCheck() {
    revision.current++; setVerification(null); setVerificationError('');
  }

  async function verify() {
    if (inFlight.current || !data || !canVerify) return;
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

  return <ManagementCard title="Identity engine" description="Create reusable character likenesses from portrait references. Generations use your organisation’s Particl credits.">
    {!data ? <p role="status">{error ? "Engine status could not be loaded." : "Loading engine status…"}</p>
      : <p role="status">{key?.set ? "Identity engine available" : "Identity engine temporarily unavailable"}</p>}
    {data && superAdmin && <div className="mt-5 space-y-3">
      <p className="text-sm text-mute">Check the saved connection and available identity render price estimates. No training or generation credits are spent.</p>
      <button className="management-button" style={{ minHeight: 44 }} type="button" disabled={!!busy || !canVerify} onClick={() => void verify()}>{busy === 'verify' ? 'Verifying connection…' : 'Verify connection'}</button>
      {!canVerify && <p className="text-sm text-mute">Configure the shared engine in the private deployment settings to verify it.</p>}
      {verificationError && <ManagementNotice error>{verificationError}</ManagementNotice>}
      {verification && <ManagementNotice error={verification.auth === 'rejected' || verification.auth === 'unavailable' || verification.auth === 'not_configured'}>
        <div className="space-y-2" aria-label="Identity account verification result">
          <p><strong>{authLabels[verification.auth]}</strong></p>
          {verification.error && <p>{problemLabels[verification.error]}</p>}
          {(['720p','1080p'] as const).map(resolution => {
            const estimate = verification.estimates[resolution];
            return <p key={resolution}><strong>{resolution}:</strong> {estimate.status === 'quoted' ? `${estimate.credits} credits estimated` : `${estimate.status === 'skipped' ? 'Not checked' : 'Estimate unavailable'} — ${estimate.error ? problemLabels[estimate.error] : 'No estimate was returned.'}`}</p>;
          })}
          <p>No training or generation was started. This check does not enable the rendering model.</p>
        </div>
      </ManagementNotice>}
    </div>}
  </ManagementCard>;
}
