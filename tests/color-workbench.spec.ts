import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/*
 * The colour renderer against its CPU reference. This is pure logic in a browser (WebGL), so it keeps. It used to borrow the
 * old Studio shell as its page; any page of the site will do, so it opens the sign-in page. The rest of this file drove the
 * old Studio's colour stage and is gone (Q15).
 */

test("GPU color interpolation matches the CPU reference with domains, partial mix and image orientation", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "workbench-1440x900",
    "One GPU interpolation and orientation regression.",
  );
  for (const name of ["color-render", "color-lut", "color"]) {
    const source = await readFile(`lib/workbench/${name}.ts`, "utf8");
    const js = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      })
      .outputText.replace(
        /from "\.\/(color-lut|color)"/g,
        'from "/__color-test__/$1.js"',
      );
    await page.route(`**/__color-test__/${name}.js`, (route) =>
      route.fulfill({ body: js, contentType: "text/javascript" }),
    );
  }
  await page.goto("/login");
  const samples = await page.evaluate(async () => {
    const rendererUrl = "/__color-test__/color-render.js",
      cubeUrl = "/__color-test__/color-lut.js";
    const { createColorRenderer } = (await import(
      rendererUrl
    )) as typeof import("../lib/workbench/color-render");
    const { parseCube, sampleCube } = (await import(
      cubeUrl
    )) as typeof import("../lib/workbench/color-lut");
    const rows = Array.from({ length: 27 }, (_, i) => {
      const r = (i % 3) / 2,
        g = (Math.floor(i / 3) % 3) / 2,
        b = Math.floor(i / 9) / 2;
      return `${g * g} ${b * b} ${r * r}`;
    }).join("\n");
    const lut = parseCube(
        `LUT_3D_SIZE 3\nDOMAIN_MIN -0.1 0 0\nDOMAIN_MAX 0.9 1 2\n${rows}`,
      ),
      renderer = createColorRenderer(lut);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext("2d")!,
        bytes = new Uint8ClampedArray([
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 64, 128, 192, 255,
        ]);
      ctx.putImageData(new ImageData(bytes, 2, 2), 0, 0);
      const result = renderer.render(canvas, {
        mix: 0.4,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        bypassed: false,
      });
      const output = document.createElement("canvas");
      output.width = 2;
      output.height = 2;
      const out = output.getContext("2d")!;
      out.drawImage(result, 0, 0);
      const actual = [...out.getImageData(0, 0, 2, 2).data];
      const expected = Array.from({ length: 4 }, (_, i) => {
        const rgb = [...bytes.slice(i * 4, i * 4 + 3)].map((n) => n / 255),
          mapped = sampleCube(lut, rgb);
        return [
          ...rgb.map((v, j) => Math.round((v * 0.6 + mapped[j] * 0.4) * 255)),
          255,
        ];
      }).flat();
      return { actual, expected };
    } finally {
      renderer.dispose();
    }
  });
  samples.actual.forEach((value, index) =>
    expect(Math.abs(value - samples.expected[index])).toBeLessThanOrEqual(1),
  );
});
