import { expect, test } from "vitest";
import { colorAlpha } from "./colorAlpha.mjs";

test.each([
  ["transparent", 0],
  ["rgb(10 20 30 / none)", 0],
  ["oklch(50% 0.1 30 / NONE)", 0],
  ["rgb(10 20 30 / 1e0)", 1],
  ["rgb(10 20 30 / 5e-1)", 0.5],
  ["rgba(10, 20, 30, 1e-2)", 0.01],
  ["rgb(10 20 30 / 5e1%)", 0.5],
  ["rgba(255, 255, 255, 0.028)", 0.028],
  ["rgba(24, 32, 51, 0.025)", 0.025],
  ["rgba(0, 0, 0, 1)", 1],
  ["rgb(10 20 30 / 50%)", 0.5],
  ["oklch(50% 0.1 30 / 0.8)", 0.8],
  ["color(srgb 1 1 1 / 0.2)", 0.2],
  ["hsla(0, 0%, 100%, 75%)", 0.75],
  ["rgb(255, 255, 255)", 1],
  ["oklch(50% 0.1 30)", 1],
  ["color(srgb 1 1 1)", 1],
  ["rgb(10 20 30 / 100%)", 1],
])("extracts the alpha of %s", (color, alpha) => {
  expect(colorAlpha(color)).toBe(alpha);
});
