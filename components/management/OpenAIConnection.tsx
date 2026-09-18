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
      if (!response.ok) throw new Error(value.error || 'The OpenAI connection check failed.');
      if (!value.verified) throw new Error(value.error || 'The saved OpenAI key could not be verified.');
      setMessage(`OpenAI authentication verified. ${value.astraAvailable ? 'GPT-6 Astra appears in this key’s model catalogue.' : 'GPT-6 Astra is not in this key’s model catalogue.'} This read-only check did not generate content or verify paid generation.`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <ManagementCard title="OpenAI direct" description="OpenAI models use the workspace’s OpenAI key, or the platform’s private OPENAI_API_KEY, when configured. Other providers keep their existing connections."><p>Use a project API key with Models read and Responses/Chat Completions write permissions. Billing and model access are managed in your OpenAI project.</p><button className="button" disabled={busy} onClick={() => void verify()}>{busy ? 'Checking OpenAI…' : 'Verify OpenAI connection'}</button>{message && <ManagementNotice>{message}</ManagementNotice>}</ManagementCard>;
}
