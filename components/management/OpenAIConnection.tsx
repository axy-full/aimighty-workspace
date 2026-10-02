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
  return <ManagementCard title="Connected language account" description="Direct thinking models use the shared language engine and your organisation’s Particl credits."><p>Check that the language engine is available for your workspace.</p><button className="button" disabled={busy} onClick={() => void verify()}>{busy ? 'Checking the account…' : 'Verify language account'}</button>{message && <ManagementNotice>{message}</ManagementNotice>}</ManagementCard>;
}
