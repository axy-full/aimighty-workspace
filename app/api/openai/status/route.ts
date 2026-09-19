import { withTenant, requireOwner } from '@/lib/auth';
import { openAIConnection } from '@/lib/openai-models';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = withTenant(async () => {
  const auth = await requireOwner();
  if (auth.response) return auth.response;
  const connection = await openAIConnection(true);
  return Response.json({ ...connection, astraAvailable: connection.models.includes('gpt-6-astra'), route: 'Language account, direct', generationTested: false }, { headers: { 'Cache-Control': 'private, no-store' } });
});
