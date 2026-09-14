import { withTenant, requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { pipelineStore } from "@/lib/pipeline/store";
import { publicRun } from "@/lib/pipeline/service";
import { PipelineError } from "@/lib/pipeline/schema";
import { MODELS } from "@/lib/models";
import { SPEECH_MODELS, SFX_MODEL, MUSIC_MODEL } from "@/lib/elevenlabs";
import { providerConfigured, PROVIDERS } from "@/lib/providers";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export const GET = withTenant(async (req) => {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const store = await pipelineStore(),
    projectId = new URL(req.url).searchParams.get("projectId") || undefined;
  const publications = (
    await db().execute({
      sql: `SELECT b.project_id AS projectId,b.version,p.name,b.body FROM workbench_bibles b JOIN projects p ON p.id=b.project_id ${projectId ? "WHERE b.project_id=?" : ""} ORDER BY b.created_at DESC LIMIT 100`,
      args: projectId ? [projectId] : [],
    })
  ).rows.map((row) => {
    const body = JSON.parse(String(row.body));
    return {
      projectId: String(row.projectId),
      version: Number(row.version),
      name: String(row.name),
      prompts: [
        ...["brief", "script", "direction"]
          .filter((key) => typeof body[key] === "string" && body[key].trim())
          .map((key) => ({
            source: key,
            label: key,
            preview: String(body[key]).slice(0, 160),
          })),
        ...(Array.isArray(body.nodes) ? body.nodes : [])
          .filter((n: { text?: string }) => n.text?.trim())
          .map((n: { id: string; title?: string; text: string }) => ({
            source: "node",
            nodeId: n.id,
            label: n.title || n.id,
            preview: n.text.slice(0, 160),
          })),
      ],
      assets: (Array.isArray(body.assets) ? body.assets : [])
        .filter(
          (a: { kind: string; uploadId?: string; generationId?: string }) =>
            ["image", "video"].includes(a.kind) &&
            (a.uploadId || a.generationId),
        )
        .map((a: { id: string; name: string; kind: string }) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
        })),
    };
  });
  const models = MODELS.filter(
    (m) =>
      ["image", "video"].includes(m.kind) &&
      !m.hidden &&
      !m.stillTask &&
      (!m.supportsTasks || m.supportsTasks.includes("generate")) &&
      m.ratios.includes("16:9"),
  ).map((m) => ({
    id: m.id,
    label: m.label,
    kind: m.kind,
    resolutions: m.resolutions,
    ratios: m.ratios,
    durations: m.durations,
    supportsAudio: m.supportsAudio,
    configured: Boolean(
      PROVIDERS.find((p) => p.id === m.provider && providerConfigured(p)),
    ),
  }));
  return Response.json(
    {
      runs: (await store.listRuns(auth.user.id, projectId)).map(publicRun),
      publications,
      models,
      audioModels: {
        speech: SPEECH_MODELS.map((m) => ({ id: m.id, label: m.label })),
        sound: SFX_MODEL,
        music: MUSIC_MODEL,
      },
    },
    { headers },
  );
});
export const POST = withTenant(
  async (req) => {
    const auth = await requireSession();
    if (auth.response) return auth.response;
    try {
      const body = JSON.parse(await readBoundedText(req, 1_000_000));
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new PipelineError("Check the pipeline fields.");
      const store = await pipelineStore();
      const version = await store.saveVersion(
        auth.user.id,
        body.spec,
        body.expectedVersion ?? 0,
        body.pipelineId,
      );
      const run = await store.createRun(
        auth.user.id,
        version.id,
        version.version,
      );
      return Response.json({ run: publicRun(run) }, { status: 201, headers });
    } catch (error) {
      if (error instanceof RequestBodyError)
        return Response.json(
          { error: error.status === 413 ? "Pipeline is too large." : "Check the pipeline fields." },
          { status: error.status, headers },
        );
      if (error instanceof PipelineError)
        return Response.json(
          { error: error.message, code: error.code },
          { status: error.status, headers },
        );
      if (error instanceof SyntaxError)
        return Response.json(
          { error: "Check the pipeline fields." },
          { status: 400, headers },
        );
      console.error(JSON.stringify({ event: "pipeline.create_failed" }));
      return Response.json(
        { error: "Pipeline could not be saved. Please try again." },
        { status: 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
