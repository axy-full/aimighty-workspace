import type { Route } from "@playwright/test";

/**
 * A browser-side stand-in for the paid routes' claim rules (lib/generationRequests.ts), for
 * specs whose engines are mocked in the page: POST /api/generate and /api/audio admit one job
 * per Idempotency-Key (a key seen again answers from its claim; a key set aside answers 409,
 * complete), bill the price the server holds now within the request's maxCredits, and POST
 * /api/generate/check reads a key's claim or sets a never-seen key aside, as the real route.
 * Quotes answer at `price`, which a spec moves to stand for a price that changed.
 */
export type ClaimsServer = {
  price: number;
  /** What the coming paid POSTs do, in order (then answered): lost before the server, lost after it (made, reply dropped), or answered. */
  plan: ("before" | "after" | "answer")[];
  charges: number[];
  sent: { path: string; key: string | undefined; body: Record<string, unknown> }[];
  checks: { key: string; endpoint: string }[];
  handle(route: Route): Promise<boolean>;
};

export function claimsServer(price: number): ClaimsServer {
  const claims = new Map<string, { body: string; reply: { status: number; json: Record<string, unknown> } }>();
  let jobs = 0;
  const server: ClaimsServer = {
    price, plan: [], charges: [], sent: [], checks: [],
    async handle(route) {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "POST" || !["/api/generate", "/api/audio", "/api/generate/quote", "/api/generate/check"].includes(path)) return false;
      const body = request.postDataJSON() as Record<string, unknown>;
      const json = (value: unknown, status = 200, complete = false) =>
        route.fulfill({ status, contentType: "application/json", headers: complete ? { "Idempotency-Status": "complete" } : {}, body: JSON.stringify(value) });
      if (path === "/api/generate/quote" || (path === "/api/audio" && body.quoteOnly))
        return json({ estimatedCredits: server.price, price: server.price, unit: "cr", fingerprint: "c".repeat(64) }), true;
      if (path === "/api/generate/check") {
        const key = String(body.key);
        server.checks.push({ key, endpoint: String(body.endpoint) });
        const claim = claims.get(key);
        if (!claim) {
          claims.set(key, { body: String(body.body), reply: { status: 409, json: { error: "This request was set aside: it had not reached the server when it was checked. Nothing was charged.", code: "set_aside" } } });
          return json({ state: "absent" }), true;
        }
        if (claim.reply.json.code === "set_aside") return json({ state: "absent" }), true;
        if (typeof claim.reply.json.id === "string") return json({ state: "landed", id: claim.reply.json.id, status: "running" }), true;
        return json({ state: "refused", status: claim.reply.status, error: String(claim.reply.json.error ?? "") }), true;
      }
      const key = request.headers()["idempotency-key"];
      server.sent.push({ path, key, body });
      const next = server.plan.shift() ?? "answer";
      if (next === "before") return route.abort("internetdisconnected"), true;
      const claim = key ? claims.get(key) : undefined;
      if (claim) {
        if (claim.body !== request.postData()) return json({ error: "This Idempotency-Key already names a different request." }, 409), true;
        return json(claim.reply.json, claim.reply.status, true), true;
      }
      let reply: { status: number; json: Record<string, unknown> };
      if (typeof body.maxCredits === "number" && server.price > body.maxCredits) reply = { status: 409, json: { error: "The generation estimate changed. Review the updated credit quote before generating." } };
      else {
        server.charges.push(server.price);
        reply = { status: 202, json: { id: `mock-job-${++jobs}`, status: "running" } };
      }
      if (key) claims.set(key, { body: request.postData()!, reply });
      if (next === "after") return route.abort("connectionreset"), true;
      return json(reply.json, reply.status, true), true;
    },
  };
  return server;
}
