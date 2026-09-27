/**
 * A paid submission that failed before its request left this server.
 *
 * Building a vendor request reads references, checks the engine's rules and
 * finds the key. When any of that throws, no provider ever saw the job, so
 * nothing can have been charged: the reservation is released instead of
 * being kept as an unconfirmed outcome.
 */
export class PreflightError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PreflightError";
  }
}

/** Run everything that happens before the paid request; any failure becomes a PreflightError. */
export async function preflight<T>(build: () => T | Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
