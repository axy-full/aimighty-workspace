import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { AtomikMark } from "../../components/AtomikMark";
import { RING_DOTS } from "../../lib/ring";
import { Mark, TRAIL } from "../../components/ui/Mark";

function circles(svg: string) {
  return [...svg.matchAll(/<circle\b[^>]*>/g)].map(([circle]) =>
    ["cx", "cy", "r"].map((attribute) =>
      Number(circle.match(new RegExp(`\\b${attribute}="([^"]+)"`))?.[1]),
    ),
  );
}

// Playwright's TSX transform returns element records, so inspect the component's
// generated SVG properties without coupling this geometry check to a browser.
type Svg = {
  props: {
    fill: string;
    width: number;
    height: number;
    viewBox: string;
    children: { type: string; props: { cx: number; cy: number; r: number } }[];
  };
};
function renderedCircles(svg: Svg) {
  expect(svg.props.children.every((child) => child.type === "circle")).toBe(
    true,
  );
  return svg.props.children.map(({ props }) => [props.cx, props.cy, props.r]);
}

test("Atomik keeps the previous website's original eight-dot SVG geometry on both grounds", () => {
  const dark = readFileSync(
    "design/particl-v2/assets/atomik-ring-on-dark.svg",
    "utf8",
  );
  const light = readFileSync(
    "design/particl-v2/assets/atomik-ring-on-light.svg",
    "utf8",
  );
  expect(circles(dark)).toHaveLength(8);
  expect(circles(light)).toEqual(circles(dark));
  expect(RING_DOTS).toEqual(circles(dark));
  const rendered = AtomikMark({ size: 20 }) as unknown as Svg;
  expect(renderedCircles(rendered)).toEqual(circles(dark));
  expect(rendered.props).toMatchObject({
    fill: "currentColor",
    width: 20,
    height: 20,
  });
});

test("the workbench uses the shared Atomik mark instead of the unrelated orbital icon", () => {
  const studio = readFileSync("components/workbench/Studio.tsx", "utf8");
  expect(studio.includes("@/components/AtomikMark")).toBe(true);
  expect(/<AtomikMark\b/.test(studio)).toBe(true);
  expect(studio.includes('rx="13" ry="5.3"')).toBe(false);
});

test("the shared Particl mark preserves the previous website's seven-dot trail", () => {
  const reference = readFileSync(
    "design/particl-v2/assets/particl-mark-on-dark.svg",
    "utf8",
  );
  const shipped = readFileSync("public/brand/particl-mark-on-dark.svg", "utf8");
  expect(circles(reference)).toHaveLength(7);
  expect(circles(shipped)).toEqual(circles(reference));
  expect(TRAIL).toEqual(circles(reference));
  const rendered = Mark({}) as unknown as Svg;
  expect(renderedCircles(rendered)).toEqual(circles(reference));
  expect(rendered.props.viewBox).toBe("30 68 140 64");
});
