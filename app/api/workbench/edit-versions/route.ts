import { z } from "zod";
import { withTenant, requireSession } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { readProjectBody } from "@/lib/workbench/request-body";
import {
  listEditVersions,
  readEditVersion,
  saveEditVersion,
} from "@/lib/workbench/edit-versions";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const id = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
export const GET = withTenant(async (req: Request) => {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const problem = workbenchScopeProblem(
    req,
    requireTenant().id,
    auth.user.id,
    true,
  );
  if (problem)
    return Response.json({ error: problem }, { status: 409, headers });
  const params = new URL(req.url).searchParams,
    draft = id.safeParse(params.get("draftId")),
    version = params.get("id");
  if (!draft.success || (version !== null && !id.safeParse(version).success))
    return Response.json(
      { error: "Choose a production and edit version." },
      { status: 400, headers },
    );
  try {
    if (version) {
      const result = await readEditVersion(auth.user.id, draft.data, version);
      return Response.json(result ?? { error: "Edit version not found." }, {
        status: result ? 200 : 404,
        headers,
      });
    }
    return Response.json(
      { versions: await listEditVersions(auth.user.id, draft.data) },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not read edit history.",
      },
      { status: 409, headers },
    );
  }
});
export const POST = withTenant(async (req: Request) => {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const problem = workbenchScopeProblem(
    req,
    requireTenant().id,
    auth.user.id,
    true,
  );
  if (problem)
    return Response.json({ error: problem }, { status: 409, headers });
  const body = await readProjectBody(req);
  if (!body.ok)
    return Response.json(
      { error: body.error },
      { status: body.status, headers },
    );
  const parsed = z
    .object({
      draftId: id,
      id: id.min(16),
      label: z.string().trim().min(1).max(100),
      revision: z.number().int().positive(),
    })
    .strict()
    .safeParse(body.value);
  if (!parsed.success)
    return Response.json(
      { error: "Choose a name and the saved production revision." },
      { status: 400, headers },
    );
  try {
    const p = parsed.data;
    return Response.json(
      {
        version: await saveEditVersion(
          auth.user.id,
          p.draftId,
          p.id,
          p.label,
          p.revision,
        ),
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not save edit version.",
      },
      { status: 409, headers },
    );
  }
});
