import { ROOT_CONTEXT, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { installModelTracer, MODEL_SPAN, type ModelSpan, type ModelTracer } from "./modelTrace";

/**
 * Sends lib/modelTrace.ts's spans to Langfuse. Imported only by instrumentation.ts when LANGFUSE_ENABLED is exactly
 * "1" (and by the tests): with tracing off, nothing here is loaded.
 *
 * The tracer provider is our own and is never registered globally, so Next.js's request spans and every other
 * library's spans are never even created by it; the export filter below admits only this module's scope as well.
 * Each model call is the root of its own trace (nothing links it to an incoming request's trace context).
 * Spans leave in batches, off the request: an export that is slow or fails is dropped by the processor and never
 * reaches the person's request.
 */

/** The variables read, by name. Values are never logged. */
export const LANGFUSE_REQUIRED = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"] as const;

/** Tracing is on only when LANGFUSE_ENABLED is exactly "1": "true", " 1", "yes" and "1\n" are off. */
export const langfuseEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.LANGFUSE_ENABLED === "1";

/** Names of what is missing or unusable; empty when Langfuse can be reached. The base URL is https, or http to this machine only. */
export function langfuseConfigProblems(env: Record<string, string | undefined> = process.env): { missing: string[]; invalid: string[] } {
  const missing = LANGFUSE_REQUIRED.filter((name) => !env[name]?.trim());
  const invalid: string[] = [];
  const base = env.LANGFUSE_BASE_URL?.trim();
  if (base) {
    try {
      const url = new URL(base);
      const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (!(url.protocol === "https:" || local) || url.username || url.password || url.search || url.hash) invalid.push("LANGFUSE_BASE_URL");
    } catch { invalid.push("LANGFUSE_BASE_URL"); }
  }
  return { missing, invalid };
}

/** Only this module's spans leave the process, whatever else a processor is handed. */
export const exportsOnlyModelSpans = (span: ReadableSpan): boolean =>
  span.instrumentationScope.name === MODEL_SPAN.scope && (span.name === MODEL_SPAN.name || span.name === MODEL_SPAN.stepName);

/** An OpenTelemetry tracer as lib/modelTrace.ts uses it. */
export function otelModelTracer(tracer: Tracer): ModelTracer {
  const wrap = (span: Span): ModelSpan => ({
    setAttributes: (attributes) => { span.setAttributes(attributes); },
    setError: (message) => { span.setStatus({ code: SpanStatusCode.ERROR, message }); },
    child: (name, attributes) => wrap(tracer.startSpan(name, { attributes }, trace.setSpan(ROOT_CONTEXT, span))),
    end: () => span.end(),
  });
  return { start: (name, attributes) => wrap(tracer.startSpan(name, { attributes, root: true }, ROOT_CONTEXT)) };
}

/** A private tracer provider over the given processors, installed as the model tracer. Returns it, so a test can flush or shut it down. */
export function installModelSpanProcessors(processors: SpanProcessor[]): BasicTracerProvider {
  const provider = new BasicTracerProvider({ spanProcessors: processors });
  installModelTracer(otelModelTracer(provider.getTracer(MODEL_SPAN.scope)));
  return provider;
}

/**
 * Called once at boot by instrumentation.ts. With a variable missing or unusable it logs one line naming it (never a
 * value) and leaves tracing off; the app runs as it does without Langfuse.
 */
export function startLangfuseTracing(env: Record<string, string | undefined> = process.env): BasicTracerProvider | null {
  if (!langfuseEnabled(env)) return null;
  const { missing, invalid } = langfuseConfigProblems(env);
  if (missing.length || invalid.length) {
    console.error(JSON.stringify({ level: "error", event: "langfuse.not_started", missing, invalid, at: new Date().toISOString() }));
    return null;
  }
  try {
    const processor = new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY!.trim(), secretKey: env.LANGFUSE_SECRET_KEY!.trim(), baseUrl: env.LANGFUSE_BASE_URL!.trim().replace(/\/$/, ""),
      environment: env.LANGFUSE_ENVIRONMENT?.trim() || undefined,
      exportMode: "batched", mediaUploadEnabled: false,
      shouldExportSpan: ({ otelSpan }) => exportsOnlyModelSpans(otelSpan),
    });
    const provider = installModelSpanProcessors([processor]);
    console.log(JSON.stringify({ level: "info", event: "langfuse.started", environment: env.LANGFUSE_ENVIRONMENT?.trim() || null, at: new Date().toISOString() }));
    return provider;
  } catch (error) {
    installModelTracer(null);
    console.error(JSON.stringify({ level: "error", event: "langfuse.not_started", error: error instanceof Error ? error.name : "Error", at: new Date().toISOString() }));
    return null;
  }
}
