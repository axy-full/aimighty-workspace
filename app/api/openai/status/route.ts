import { withTenant, requireSuperAdmin } from '@/lib/auth';
import { openAIConnection } from '@/lib/openai-models';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * The language account's live model list, for the platform's owner alone (owner, 24 Oct 2026, item 14 (c)): it names models, so no member,
 * workspace owner or token may read it. requireSuperAdmin is the console's own gate (lib/auth.ts › isPlatformOwner), and refuses a token first.
 */
export const GET = withTenant(async () => {
  const auth = await requireSuperAdmin();
  if (auth.response) return auth.response;
  const connection = await openAIConnection(true);
  return Response.json({ ...connection, astraAvailable: connection.models.includes('gpt-6-astra'), route: 'Language account, direct', generationTested: false }, { headers: { 'Cache-Control': 'private, no-store' } });
});
