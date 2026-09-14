/** Real local HTTP regression extension. Caller owns an isolated fixture server and deny-all-external-fetch guard. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@libsql/client";

export async function verifyUploadHttp({
  api,
  context,
  platform,
  json,
  workspaceId,
  email,
}) {
  const account = (
    await platform.execute({
      sql: "SELECT id FROM accounts WHERE email=?",
      args: [email],
    })
  ).rows[0];
  const workspace = (
    await platform.execute({
      sql: "SELECT db_url FROM workspaces WHERE id=?",
      args: [workspaceId],
    })
  ).rows[0];
  if (!String(workspace.db_url).startsWith("file:"))
    throw new Error("Upload rehearsal requires a disposable local database");
  const tenant = createClient({ url: String(workspace.db_url) });
  const bytes = Buffer.from("hello!"),
    scope = `particl-active-${workspaceId}-${account.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const sessions = [randomUUID(), randomUUID()];
  const chunk = (
    session,
    data = bytes,
    customHeaders = headers,
    client = api,
  ) =>
    client.post("/api/uploads/chunk", {
      headers: customHeaders,
      multipart: {
        session,
        index: "0",
        chunk: {
          name: "part",
          mimeType: "application/octet-stream",
          buffer: data,
        },
      },
    });
  try {
    await platform.execute({
      sql: "UPDATE workspaces SET storage_quota_bytes=10 WHERE id=?",
      args: [workspaceId],
    });
    await json(await chunk(sessions[0], bytes, {}), 409);
    await json(
      await chunk(sessions[0], bytes, {
        "X-Workbench-Scope": "particl-active-another-account",
      }),
      409,
    );
    const attempts = await Promise.all(
      sessions.map((session) => chunk(session)),
    );
    assert.deepEqual(
      attempts.map((response) => response.status()).sort(),
      [200, 507],
    );
    const accepted =
      sessions[attempts.findIndex((response) => response.status() === 200)];
    assert.equal(
      Number(
        (
          await tenant.execute(
            "SELECT SUM(reserved_bytes) n FROM upload_sessions",
          )
        ).rows[0].n,
      ),
      bytes.length,
    );
    await json(await chunk(accepted), 200);
    const recovering = await json(
      await api.get("/api/uploads/session?session=" + accepted, { headers }),
      200,
    );
    assert.equal(recovering.state, "open");
    assert.deepEqual(recovering.storedChunks, [0]);
    await json(await chunk(accepted, Buffer.from("other!")), 409);
    const finish = () =>
      api.post("/api/uploads/finish", {
        timeout: 120_000,
        headers,
        data: {
          session: accepted,
          count: 1,
          filename: "notes.txt",
          purpose: "chat",
        },
      });
    const uploaded = await json(await finish(), 200),
      replay = await json(await finish(), 200);
    assert.equal(uploaded.id, replay.id);
    const recovered = await json(
      await api.get("/api/uploads/session?session=" + accepted, { headers }),
      200,
    );
    assert.equal(recovered.state, "committed");
    assert.equal(recovered.upload.id, uploaded.id);
    assert.equal(
      uploaded.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const media = await api.get(uploaded.url);
    assert.equal(media.status(), 200);
    assert.deepEqual(await media.body(), bytes);
    assert.equal(media.headers()["cache-control"], "private, no-store");
    assert.equal(media.headers()["x-content-type-options"], "nosniff");
    assert.equal(
      Number(
        (
          await tenant.execute(
            "SELECT SUM(reserved_bytes) n FROM upload_sessions",
          )
        ).rows[0].n,
      ),
      0,
    );
    assert.equal(
      Number(
        (await tenant.execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
      ),
      1,
    );
    await tenant.execute({
      sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('upload-http-private','other-owner','private-fixture','Private fixture',?,1,0)",
      args: [JSON.stringify({ assets: [{ url: uploaded.url }] })],
    });
    await json(await api.delete(uploaded.url, { headers }), 409);
    assert.equal((await api.get(uploaded.url)).status(), 200);
    await tenant.execute(
      "DELETE FROM workbench_projects WHERE key='upload-http-private'",
    );
    await json(await api.delete(uploaded.url, { headers }), 200);
    assert.equal((await api.get(uploaded.url)).status(), 404);
    assert.equal(
      (
        await json(
          await api.get("/api/uploads/session?session=" + accepted, {
            headers,
          }),
          200,
        )
      ).state,
      "removed",
    );
    assert.equal(
      Number(
        (
          await tenant.execute(
            "SELECT SUM(reserved_bytes) n FROM upload_sessions",
          )
        ).rows[0].n,
      ),
      0,
    );
    const uploadToken = await json(
      await api.post("/api/tokens", {
        headers,
        data: { name: "Local upload fixture", scope: "render" },
      }),
      200,
    );
    const bearer = { Authorization: `Bearer ${uploadToken.token}` },
      tokenSession = randomUUID();
    const tokenApi = await context(bearer);
    await json(await chunk(tokenSession, bytes, bearer, tokenApi), 200);
    await json(
      await tokenApi.delete("/api/uploads/chunk", {
        headers: bearer,
        data: { session: tokenSession },
      }),
      200,
    );
    console.log(
      "PASS: HTTP upload required scope/bearer compatibility, atomic quota, immutable chunk replay, finish recovery, byte hash, private binding protection and durable deletion.",
    );
  } finally {
    await platform.execute({
      sql: "UPDATE workspaces SET storage_quota_bytes=NULL WHERE id=?",
      args: [workspaceId],
    });
    tenant.close();
  }
}
