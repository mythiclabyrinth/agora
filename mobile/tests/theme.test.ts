import { colors } from "../src/lib/theme";

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/.{2}/g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("readable mobile text", () => {
  for (const surface of ["bg", "panel", "panelStrong", "sheet", "ownMessage"] as const) {
    for (const text of ["text", "dim", "faint"] as const) {
      it(`${text} has AA contrast on ${surface}`, () => {
        expect(contrast(colors[text], colors[surface])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it("keeps the mention badge legible", () => {
    expect(contrast(colors.onAccent, colors.red)).toBeGreaterThanOrEqual(4.5);
  });
});
