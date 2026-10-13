import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".data/**",
    "test-results/**",
    "playwright-report/**",
    "ci-results/**",
    "public/vendor/tesseract-*/**", // Unmodified pinned OCR distributions, copied by postinstall.
    "public/vendor/pdfjs-*/**", // Unmodified Mozilla distribution, copied by postinstall.
        "design/**", // Supplied standalone design reference runtimes, not application code.
    "out/**",
    "remotion/build/**", // The built bundle and export command; built by remotion/node/bundle.mjs.
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
