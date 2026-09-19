/** Qualification results are owner-only diagnostic data. Never evaluate these
 * instructions/schemas, embed their media, or fetch URLs found in them. */
export type QualificationValue =
  | null
  | boolean
  | number
  | string
  | QualificationValue[]
  | { [key: string]: QualificationValue };
export class QualificationPayloadError extends Error {
  constructor(readonly code: "invalid_result" | "result_limit") {
    super(
      code === "result_limit"
        ? "The read-only result exceeded the diagnostic limit."
        : "The connected account returned an unusable read-only result.",
    );
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const PRIVATE_FIELDS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "sessiontoken",
  "apikey",
  "hfapikey",
  "hfsecret",
  "hfcredentials",
  "keyid",
  "apisecret",
  "keysecret",
  "clientsecret",
  "password",
  "secret",
  "authorization",
  "cookie",
  "setcookie",
  "credentials",
  "credential",
]);

export function consumerSecretForms(secrets: readonly string[]) {
  return [
    ...new Set(
      secrets.filter(Boolean).flatMap((secret) => {
        const encoded = encodeURIComponent(secret);
        return [
          secret,
          encoded,
          encoded.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()),
        ];
      }),
    ),
  ];
}

/** Case-insensitive matching also covers mixed-case percent escapes. It is
 * intentionally conservative for private credentials, never used for auth. */
export function containsConsumerSecret(
  text: string,
  secrets: readonly string[],
) {
  const lower = text.toLowerCase();
  return secrets.some((secret) => lower.includes(secret.toLowerCase()));
}

export function normalizeQualificationResult(
  raw: Record<string, unknown>,
  secrets: readonly string[],
): { result: QualificationValue; isError: boolean } {
  const fail = (
    code: "invalid_result" | "result_limit" = "invalid_result",
  ): never => {
    throw new QualificationPayloadError(code);
  };
  if (raw.isError !== undefined && typeof raw.isError !== "boolean") fail();
  if (
    raw.content !== undefined &&
    (!Array.isArray(raw.content) || raw.content.length > 128)
  )
    fail();
  let value: unknown;
  if (raw.structuredContent !== undefined) {
    if (!object(raw.structuredContent)) fail();
    value = raw.structuredContent;
  } else {
    const content = raw.content;
    if (!Array.isArray(content)) return fail();
    const text: unknown[] = [];
    let omittedNonTextContent = 0;
    for (const block of content) {
      if (!object(block) || typeof block.type !== "string") fail();
      if (block.type !== "text") {
        omittedNonTextContent++;
        continue;
      }
      if (typeof block.text !== "string") fail();
      try {
        text.push(JSON.parse(block.text));
      } catch {
        text.push(block.text);
      }
    }
    value = text.length === 1 ? text[0] : text;
    if (omittedNonTextContent) value = { text: value, omittedNonTextContent };
  }
  const known = consumerSecretForms(secrets);
  function redact(text: string) {
    for (const secret of known) {
      const lower = text.toLowerCase(),
        needle = secret.toLowerCase();
      const parts: string[] = [];
      let from = 0,
        at: number;
      while ((at = lower.indexOf(needle, from)) !== -1) {
        parts.push(text.slice(from, at), "[redacted]");
        from = at + secret.length;
      }
      if (from) text = parts.join("") + text.slice(from);
    }
    return text
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(
        /\b(access_token|refresh_token|id_token|api_key|client_secret|password)["']?\s*[=:]\s*["']?[^\s"'&,<>]+/gi,
        "$1=[redacted]",
      );
  }
  let nodes = 0;
  function clean(input: unknown, depth: number): QualificationValue {
    if (++nodes > 20_000 || depth > 40) return fail("result_limit");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) return fail();
      return input;
    }
    if (typeof input === "string") return redact(input);
    if (Array.isArray(input))
      return input.map((item) => clean(item, depth + 1));
    if (!object(input)) return fail();
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => [
        redact(key),
        PRIVATE_FIELDS.has(key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())
          ? "[redacted]"
          : clean(child, depth + 1),
      ]),
    );
  }
  const result = clean(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1_048_576)
    fail("result_limit");
  return { result, isError: raw.isError === true };
}
