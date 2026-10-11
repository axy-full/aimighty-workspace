import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { AccountError, accountTransaction } from "./accountDb";
import { createSession, destroySession, isSuperAdmin, sourceLocked, noteSourceFailure } from "./auth";
import { now, platformDb, platformReady, switchSessionWorkspace } from "./platform";
import { acceptWorkspaceInvitation } from "./teamInvitations";
import { configuredOrigin } from "./site";
import { GOOGLE_REFUSALS, type GoogleRefusal } from "./googleSignInText";

/**
 * "Continue with Google" (the owner's rules, 11 Oct 2026): a standard OpenID Connect authorization-code flow with PKCE, state and nonce.
 *
 *  - Google vouches for an address only where it is the mailbox's authority: an @gmail.com address, or a Google Workspace address whose
 *    signed `hd` claim is that address's own domain. For any other address (a past owner of x@company.com with a Google account made
 *    with that address) `email_verified` is not enough, so Google is refused there and the person uses Continue with email.
 *  - Invite-only stays. A person with an account signs in when Google's VERIFIED email is the account's email. A new person needs a
 *    valid team invitation, and Google's verified email must be the address that invitation names: that is also the proof of the
 *    mailbox the emailed link gives. No account is ever created from Google alone, and a Google account is never linked by anything
 *    but its verified email at the moment of sign-in (nothing about Google is stored: no `sub`, no token, no profile).
 *  - Scopes are exactly `openid email profile`. No refresh token is asked for or kept; the access token is never read.
 *  - The ID token is read once, in the callback: signature (RS256, Google's published keys), issuer, audience, expiry, nonce and
 *    `email_verified` are all checked; nothing from it is logged.
 *  - One-time state: the state cookie is signed, expires in ten minutes, is cleared on arrival, and the state is recorded as used
 *    (the same account_action_limits table the other sign-in limits use), so a replayed callback is refused even with the cookie.
 *  - Throttling is today's: a source locked out by repeated failed sign-ins (lib/auth.ts sourceLocked) is refused, and every
 *    refusal counts against the source as a wrong password does.
 *  - An account with two-step sign-in on is never opened by Google alone (central session issuance refuses it: lib/accountSecurity.ts).
 *    The platform owner's address signs in with its password and factor, never with Google.
 *
 * Google is on only when GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and APP_ORIGIN are all set; the redirect URI is built
 * from APP_ORIGIN, never from the request.
 */
export const GOOGLE_SCOPES = "openid email profile";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
export const GOOGLE_COOKIE = "particl-google";
export const STATE_TTL_MS = 10 * 60_000;
const SKEW_MS = 60_000;
/** An ID token is read within a day of being issued (Google's last an hour). */
const IAT_MAX_AGE_MS = 24 * 3_600_000;
/** The pseudo-address the Google refusals are counted under in today's sign-in throttle (lib/auth.ts noteSourceFailure). */
export const GOOGLE_THROTTLE_KEY = "google-sign-in";

type Env = Record<string, string | undefined>;

export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };

/** Null (Google off) unless the client id, its secret and the public origin are all present. */
export function googleConfig(env: Env = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(), origin = configuredOrigin(env);
  if (!clientId || !clientSecret || !origin) return null;
  return { clientId, clientSecret, redirectUri: `${origin}${GOOGLE_CALLBACK_PATH}` };
}

/* The refusals, as the person reads them, live in lib/googleSignInText.ts (no server code, so the pages can read them too). */
export { GOOGLE_REFUSALS, isGoogleRefusal, type GoogleRefusal } from "./googleSignInText";
export class GoogleRefused extends Error {
  constructor(readonly code: GoogleRefusal) { super(GOOGLE_REFUSALS[code]); this.name = "GoogleRefused"; }
}

/* ── State, PKCE and the cookie that carries them ───────────────────────── */

const b64 = (buffer: Buffer | string) => Buffer.from(buffer).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest();

export type GoogleRequest = { state: string; nonce: string; verifier: string; challenge: string };
export function newGoogleRequest(random: (n: number) => Buffer = randomBytes): GoogleRequest {
  const verifier = b64(random(48));
  return { state: b64(random(24)), nonce: b64(random(24)), verifier, challenge: b64(sha256(verifier)) };
}

export function authorizationUrl(config: GoogleConfig, request: GoogleRequest): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: GOOGLE_SCOPES,
    state: request.state, nonce: request.nonce, code_challenge: request.challenge, code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** What the signed cookie carries between the start and the callback: no secret of Google's, only this browser's own request. */
export type GoogleCookie = { state: string; nonce: string; verifier: string; invite: string; accept: boolean; next: string; exp: number };

function cookieKey(env: Env = process.env) {
  const secret = env.KEYRING_SECRET;
  if (!secret && env.NODE_ENV === "production") throw new Error("KEYRING_SECRET is not set.");
  return createHash("sha256").update("particl-google-state:" + (secret ?? "particl-dev-keyring")).digest();
}
export function sealGoogleCookie(value: GoogleCookie, env: Env = process.env): string {
  const body = b64(JSON.stringify(value));
  return `${body}.${createHmac("sha256", cookieKey(env)).update(body).digest("base64url")}`;
}
export function openGoogleCookie(raw: string | undefined | null, at = now(), env: Env = process.env): GoogleCookie | null {
  if (!raw || raw.length > 2000) return null;
  const [body, mac, extra] = raw.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(createHmac("sha256", cookieKey(env)).update(body).digest("base64url")), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<GoogleCookie>;
    if (typeof value.state !== "string" || typeof value.nonce !== "string" || typeof value.verifier !== "string" || typeof value.exp !== "number") return null;
    if (value.exp < at) return null;
    return { state: value.state, nonce: value.nonce, verifier: value.verifier, invite: typeof value.invite === "string" ? value.invite : "", accept: value.accept === true, next: typeof value.next === "string" ? value.next : "/", exp: value.exp };
  } catch { return null; }
}
export const equalText = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** A state is spent once: recorded in the table today's sign-in limits use, under a fixed bucket, so a second use finds it already counted. */
export async function spendState(state: string): Promise<boolean> {
  const key = `google-state:${sha256(state).toString("base64url")}`;
  return accountTransaction(async (tx) => {
    await tx.execute({ sql: "INSERT INTO account_action_limits(key,bucket,n) VALUES(?,0,1) ON CONFLICT(key,bucket) DO UPDATE SET n=n+1", args: [key] });
    const row = (await tx.execute({ sql: "SELECT n FROM account_action_limits WHERE key=? AND bucket=0", args: [key] })).rows[0];
    return Number(row?.n) === 1;
  });
}

/* ── Google: the code for an ID token, and the token read ───────────────── */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const timed = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(8000), cache: "no-store" });

/** Exchanges the one-time code (with the PKCE verifier) for tokens and returns only the ID token; the access token is never read or kept. */
export async function exchangeCode(config: GoogleConfig, code: string, verifier: string, fetcher: Fetcher = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, timed({
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    }));
  } catch { throw new GoogleRefused("unavailable"); }
  if (response.status >= 500) throw new GoogleRefused("unavailable");
  const body = await response.json().catch(() => null) as { id_token?: unknown } | null;
  if (!response.ok || typeof body?.id_token !== "string" || !body.id_token) throw new GoogleRefused("expired");
  return body.id_token;
}

export type Jwk = { kid?: string; kty?: string; alg?: string; n?: string; e?: string; use?: string };
let certs: { at: number; keys: Jwk[] } | null = null;
const KEYS_TTL_MS = 3_600_000, KEYS_REFETCH_MS = 60_000;
/** Google's published signing keys, kept for an hour. `force` asks again (a key id not in the list: Google rotated), at most once a minute. */
export async function googleKeys(fetcher: Fetcher = fetch, force = false): Promise<Jwk[]> {
  const age = certs ? Date.now() - certs.at : Infinity;
  if (certs && age < (force ? KEYS_REFETCH_MS : KEYS_TTL_MS)) return certs.keys;
  let response: Response;
  try { response = await fetcher(GOOGLE_CERTS_URL, timed()); } catch { throw new GoogleRefused("unavailable"); }
  const body = await response.json().catch(() => null) as { keys?: Jwk[] } | null;
  if (!response.ok || !Array.isArray(body?.keys) || !body.keys.length) throw new GoogleRefused("unavailable");
  certs = { at: Date.now(), keys: body.keys };
  return certs.keys;
}

/** The key id an ID token names, or null. */
export function kidOf(token: string): string | null {
  try { const kid = (JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: unknown }).kid; return typeof kid === "string" ? kid : null; } catch { return null; }
}

/** Google vouches for an address only for @gmail.com, or for a Workspace address whose signed `hd` is the address's own domain. */
export function googleVouchesFor(email: string, hd: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domain === "gmail.com" || (hd !== "" && hd === domain);
}

export type GoogleClaims = { email: string; name: string; hd: string };

/**
 * Reads an ID token the way OpenID Connect asks: RS256 signature against Google's keys, issuer, audience (this client), expiry,
 * the nonce this browser sent, and a verified email. Throws GoogleRefused; returns only the email and display name.
 */
export async function verifyIdToken(token: string, input: { clientId: string; nonce: string; keys: Jwk[]; at?: number }): Promise<GoogleClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8000) throw new GoogleRefused("expired");
  let header: { alg?: unknown; kid?: unknown }, payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { throw new GoogleRefused("expired"); }
  if (header.alg !== "RS256") throw new GoogleRefused("expired");
  const jwk = input.keys.find((k) => k.kid === header.kid && k.kty === "RSA" && k.n && k.e);
  if (!jwk) throw new GoogleRefused("expired");
  let valid = false;
  try {
    valid = verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: { kty: "RSA", n: jwk.n!, e: jwk.e! }, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  } catch { valid = false; }
  if (!valid) throw new GoogleRefused("expired");
  const at = input.at ?? now();
  if (typeof payload.iss !== "string" || !GOOGLE_ISSUERS.includes(payload.iss)) throw new GoogleRefused("expired");
  /* This client and no other: a list of audiences is not read (it would need an `azp` check this flow has no use for). */
  if (payload.aud !== input.clientId) throw new GoogleRefused("expired");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < at - SKEW_MS) throw new GoogleRefused("expired");
  if (typeof payload.iat !== "number" || payload.iat * 1000 > at + SKEW_MS || payload.iat * 1000 < at - IAT_MAX_AGE_MS) throw new GoogleRefused("expired");
  if (typeof payload.nonce !== "string" || !equalText(payload.nonce, input.nonce)) throw new GoogleRefused("expired");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || email.length > 320) throw new GoogleRefused("unverified");
  if (!(payload.email_verified === true || payload.email_verified === "true")) throw new GoogleRefused("unverified");
  const hd = typeof payload.hd === "string" ? payload.hd.trim().toLowerCase() : "";
  /* `email_verified` says the mailbox was proved to Google; it does not make Google the authority for it. */
  if (!googleVouchesFor(email, hd)) throw new GoogleRefused("use_email");
  return { email, name: typeof payload.name === "string" ? payload.name.trim().slice(0, 80) : "", hd };
}

/* ── The decision: who this verified email may become ───────────────────── */

export type GoogleSignedIn = { session: string; workspaceId: string | null; joined: boolean };

type Row = Record<string, unknown>;
const INVITE_CODE = /^[A-Za-z0-9_-]{8,128}$/;
export const cleanInviteCode = (raw: unknown): string => (typeof raw === "string" && INVITE_CODE.test(raw.trim()) ? raw.trim() : "");

/**
 * What a verified Google email is allowed to do (the owner's rules above). Pure of Google: the email is already proven.
 *  - an existing, live account whose email it is signs in, and with an invite for that same address also joins that one workspace;
 *  - a new person needs an open team invitation naming this address, and joins that workspace only (the account's password is a random
 *    value nobody knows, as no password was chosen: they set one by email if they want to);
 *  - anything else is refused and nothing is created.
 */
export async function signInWithVerifiedEmail(input: { email: string; name: string; invite: string; accepted: boolean }): Promise<GoogleSignedIn> {
  await platformReady();
  const email = input.email.trim().toLowerCase();
  /* The platform owner signs in with its password and factor: never with Google. */
  if (isSuperAdmin(email)) throw new GoogleRefused("two_step");
  const account = (await platformDb().execute({ sql: "SELECT id,name,disabled,deleted_at FROM accounts WHERE email=? LIMIT 1", args: [email] })).rows[0] as Row | undefined;
  /* A disabled or deleted account is not signed in, and its address is not a new person's either (an invitation does not revive it). */
  if (account && (Number(account.disabled) || account.deleted_at != null)) throw new GoogleRefused("no_account");
  const live = account ?? null;

  let invite: Row | null = null;
  if (input.invite) {
    invite = (await platformDb().execute({ sql: "SELECT * FROM workspace_invites WHERE code=? LIMIT 1", args: [input.invite] })).rows[0] as Row | undefined ?? null;
    if (!invite) {
      const signup = (await platformDb().execute({ sql: "SELECT 1 FROM signup_invites WHERE code=? LIMIT 1", args: [input.invite] })).rows[0];
      throw new GoogleRefused(signup ? "signup_invite" : "invite_invalid");
    }
    const open = !invite.used_at && Number(invite.expires_at) >= now();
    if (String(invite.email).trim().toLowerCase() !== email) throw new GoogleRefused("invite_mismatch");
    /* A used invite is still honoured for a member who simply signs in with it (as the accept page does): it only joins nobody new. */
    if (!open) invite = null;
    if (!open && !live) throw new GoogleRefused("invite_invalid");
  }
  if (!live && !invite) throw new GoogleRefused("no_account");

  let accountId: string, workspaceId: string | null = null, joined = false, session: string;
  try {
    if (live) {
      accountId = String(live.id);
      session = await createSession(accountId);
      if (invite) {
        try {
          const result = await acceptWorkspaceInvitation({ code: String(invite.code), signedInAccountId: accountId, signedInSession: session });
          workspaceId = result.workspace.id; joined = true;
        } catch (error) {
          /* Joining needed the session, but a sign-in whose invitation failed is not a sign-in: the session is ended, not handed back. */
          await destroySession(session).catch(() => {});
          throw error;
        }
      }
    } else {
      if (!input.accepted) throw new GoogleRefused("policy");
      const result = await acceptWorkspaceInvitation({
        code: String(invite!.code), password: b64(randomBytes(32)), name: String(invite!.name || input.name || ""), acceptedPolicy: true, requireMailboxProof: false,
      });
      accountId = result.accountId; workspaceId = result.workspace.id; joined = true;
      session = await createSession(accountId);
    }
  } catch (error) {
    if (error instanceof GoogleRefused) throw error;
    /* Central session issuance refuses a password-only session for an account with two-step sign-in. */
    if (error instanceof AccountError && error.status === 403 && /two-step/i.test(error.message)) throw new GoogleRefused("two_step");
    if (error instanceof AccountError && error.status === 403) throw new GoogleRefused("no_account");
    if (error instanceof AccountError && (error.status === 404 || error.status === 409 || error.status === 410)) throw new GoogleRefused("invite_invalid");
    throw error;
  }
  if (workspaceId) await switchSessionWorkspace(session, workspaceId);
  return { session, workspaceId, joined };
}

/* ── The callback, whole ────────────────────────────────────────────────── */

export type CallbackInput = {
  query: { code: string | null; state: string | null; error: string | null };
  cookie: string | undefined;
  source: string;
};
export type CallbackDeps = { config: GoogleConfig; fetcher?: Fetcher; keys?: (force: boolean) => Promise<Jwk[]>; at?: number; env?: Env };

/** Counts a refusal against the source as a wrong password is (lib/auth.ts), so probing here is throttled as hard as there. */
async function refuse(source: string, code: GoogleRefusal): Promise<never> {
  if (code !== "denied" && code !== "unavailable") await noteSourceFailure(source, GOOGLE_THROTTLE_KEY).catch(() => {});
  throw new GoogleRefused(code);
}

/**
 * Everything the callback does, with Google injected so it is tested without Google. Returns the session and where to go next, or
 * throws GoogleRefused (the route turns that into a short notice on the page the person came from).
 */
export async function completeGoogleCallback(input: CallbackInput, deps: CallbackDeps): Promise<GoogleSignedIn & { next: string }> {
  const at = deps.at ?? now();
  if (await sourceLocked(input.source, GOOGLE_THROTTLE_KEY)) throw new GoogleRefused("limited");
  const cookie = openGoogleCookie(input.cookie, at, deps.env);
  if (!cookie) return refuse(input.source, "expired");
  /* Declining at Google is not an attack; any other error from it is counted like a refusal. */
  if (input.query.error) return input.query.error === "access_denied" ? Promise.reject(new GoogleRefused("denied")) : refuse(input.source, "expired");
  if (!input.query.state || !input.query.code || !equalText(input.query.state, cookie.state)) return refuse(input.source, "expired");
  if (!(await spendState(cookie.state))) return refuse(input.source, "expired");
  let claims: GoogleClaims;
  try {
    const idToken = await exchangeCode(deps.config, input.query.code, cookie.verifier, deps.fetcher);
    const getKeys = deps.keys ?? ((force: boolean) => googleKeys(deps.fetcher, force));
    let keys = await getKeys(false);
    /* A key id Google has published since the list was kept: asked for once more (at most once a minute), then judged. */
    const kid = kidOf(idToken);
    if (kid && !keys.some((k) => k.kid === kid)) keys = await getKeys(true);
    claims = await verifyIdToken(idToken, { clientId: deps.config.clientId, nonce: cookie.nonce, keys, at });
  } catch (error) {
    if (error instanceof GoogleRefused) return refuse(input.source, error.code);
    throw error;
  }
  try {
    const done = await signInWithVerifiedEmail({ email: claims.email, name: claims.name, invite: cookie.invite, accepted: cookie.accept });
    return { ...done, next: cookie.next };
  } catch (error) {
    if (error instanceof GoogleRefused) return refuse(input.source, error.code);
    throw error;
  }
}
