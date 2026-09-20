import { withTenant } from "@/lib/auth";
export const dynamic = "force-dynamic";

/**
 * An OpenAPI description of the useful endpoints.
 *
 * ChatGPT's Custom GPT Actions want a schema and a bearer key rather than an
 * MCP connection, so this is the door for that side of the house. It is
 * deliberately a small subset — start a render, check it, list work, read
 * spend — because an action schema is a menu handed to a model, and a shorter
 * menu is a better one.
 *
 * Public on purpose: it is a description of shapes, not data. Every path it
 * names still demands a token.
 */
export const GET = withTenant(async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  return Response.json({
    openapi: "3.1.0",
    info: {
      title: "Particl",
      description:
        "Generate video, and read what it cost. Every call spends or reads " +
        "the workspace's own connected video credit.",
      version: "1.0.0",
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        workspaceToken: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Generation: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", description: "queued | running | succeeded | failed" },
            prompt: { type: "string" },
            costUsd: { type: ["number", "null"] },
            storedUrl: { type: ["string", "null"], description: "Path to the media, token required." },
            projectName: { type: ["string", "null"] },
            createdAt: { type: "number" },
          },
        },
      },
    },
    security: [{ workspaceToken: [] }],
    paths: {
      "/api/generate": {
        post: {
          operationId: "renderShot",
          summary: "Start a video render",
          description:
            "Starts a render and returns its id immediately; it takes one to three minutes. " +
            "Poll getRender until status is 'succeeded'. Prompts are auto-refined unless " +
            "prefixed with 'raw:'. This spends real money.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: {
                    prompt: { type: "string", description: "Subject, action, setting, camera, light, mood." },
                    model: {
                      type: "string",
                      enum: ["dreamina-seedance-2-5-260628", "dreamina-seedance-2-0-260128"],
                      description: "2.5 is the default and best; 2.0 is cheaper.",
                    },
                    duration: { type: "number", description: "Seconds. 5 is a good default." },
                    resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
                    ratio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
                    generateAudio: { type: "boolean", description: "Seedance 2.5 only." },
                    projectId: { type: ["string", "null"], description: "From listProjects." },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Render accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, status: { type: "string" } },
                  },
                },
              },
            },
            "403": { description: "The token is read-only" },
            "429": { description: "The token has reached its monthly ceiling" },
          },
        },
      },
      "/api/jobs": {
        get: {
          operationId: "listRenders",
          summary: "List recent renders",
          parameters: [
            { name: "limit", in: "query", schema: { type: "number" } },
            { name: "projectId", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "q", in: "query", schema: { type: "string" }, description: "Search prompt text." },
          ],
          responses: {
            "200": {
              description: "Renders, newest first",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      generations: { type: "array", items: { $ref: "#/components/schemas/Generation" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/jobs/{id}": {
        get: {
          operationId: "getRender",
          summary: "One render, with its current status and cost",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "The render",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { generation: { $ref: "#/components/schemas/Generation" } },
                  },
                },
              },
            },
            "404": { description: "No such render" },
          },
        },
      },
      "/api/projects": {
        get: {
          operationId: "listProjects",
          summary: "Projects, with render counts and spend",
          responses: { "200": { description: "Projects" } },
        },
        post: {
          operationId: "createProject",
          summary: "Create a project",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
              },
            },
          },
          responses: { "200": { description: "Created" } },
        },
      },
      "/api/usage/summary": {
        get: {
          operationId: "usageSummary",
          summary: "Spend, remaining credit and renders in flight",
          responses: { "200": { description: "Summary" } },
        },
      },
    },
  });
});
