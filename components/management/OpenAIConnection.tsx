'use client';
import { useState } from 'react';
import { useScopedFetch } from '@/lib/useScopedFetch';
import { ManagementCard, ManagementNotice } from './ManagementPage';

export default function OpenAIConnection() {
  const scopedFetch = useScopedFetch();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function verify() {
    setBusy(true); setMessage('');
    try {
      const response = await scopedFetch('/api/openai/status', { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'The language account check failed.');
      if (!value.verified) throw new Error(value.error || 'The saved language account key could not be verified.');
      setMessage(`Authentication verified. ${value.astraAvailable ? 'Astra appears in this key’s model catalogue.' : 'Astra is not in this key’s model catalogue.'} This read-only check did not generate content or verify paid generation.`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <ManagementCard title="Connected language account" description="Direct thinking models use the workspace’s own key, or the platform’s private OPENAI_API_KEY, when configured. Other providers keep their existing connections."><p>Use a project API key with Models read and Responses/Chat Completions write permissions. Billing and model access are managed in your <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">provider project</a>.</p><button className="button" disabled={busy} onClick={() => void verify()}>{busy ? 'Checking the account…' : 'Verify language account'}</button>{message && <ManagementNotice>{message}</ManagementNotice>}</ManagementCard>;
}
