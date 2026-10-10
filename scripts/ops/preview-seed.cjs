/* eslint-disable @typescript-eslint/no-require-imports -- A CommonJS build step: it compiles the app's own TypeScript in this process before loading it. */
/**
 * Preview bootstrap, run by `npm run build` through `prebuild`.
 *
 * Everything it decides is in lib/previewSeed.ts: the guard (a Vercel preview
 * build against the owner's staging databases, with SUPER_ADMIN_EMAIL set)
 * and the idempotent steps behind it. Anywhere else — CI, a local build, a
 * production deployment — it prints one "skipped" line and touches no
 * database.
 *
 * It never fails the build: a seed problem is a line in the build log, and the
 * app's own lazy schema still runs on first request. The log carries steps and
 * counts only.
 */
const fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const TIMEOUT_MS = 180_000;

function errorCode(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
  const name = error && typeof error === "object" ? error.name : undefined;
  return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
}

/** Compile the app's TypeScript on require (the `@/` alias included) and load lib/previewSeed.ts. */
function loadPreviewSeed() {
  const ts = require("typescript");
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (specifier, parent, ...rest) {
    return resolve.call(this, specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : specifier, parent, ...rest);
  };
  const compile = function (module, filename) {
    if (!filename.startsWith(root + path.sep) || filename.includes(`${path.sep}node_modules${path.sep}`))
      throw new Error("UNEXPECTED_TYPESCRIPT_SOURCE");
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    module._compile(output.outputText, filename);
  };
  Module._extensions[".ts"] = compile;
  Module._extensions[".tsx"] = compile;
  return require(path.join(root, "lib", "previewSeed.ts"));
}

function main() {
  // The deployed server's rules, not development's: provisioning needs the Turso
  // API and sealing needs KEYRING_SECRET, and a workspace is never given a local file.
  process.env.NODE_ENV = "production";
  const finish = (line) => {
    if (line) console.log(line);
    // Remote database clients may hold sockets open; the build must move on.
    setTimeout(() => process.exit(0), 100).unref();
  };
  // Anything thrown outside the awaited run (a client's background error) is one line and a passing build.
  const crash = (error) => {
    console.log(`preview seed: failed (${errorCode(error)})`);
    process.exit(0);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  setTimeout(() => {
    console.log("preview seed: failed (timeout)");
    process.exit(0);
  }, TIMEOUT_MS).unref();
  try {
    loadPreviewSeed()
      .runPreviewSeed()
      .then(
        () => finish(),
        (error) => finish(`preview seed: failed (${errorCode(error)})`),
      );
  } catch (error) {
    finish(`preview seed: failed (${errorCode(error)})`);
  }
}

module.exports = { loadPreviewSeed };
if (require.main === module) main();
