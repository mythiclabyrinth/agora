// Computed CSS colors are valid and resolved by the browser. Legacy rgba/hsla
// uses a fourth comma-separated component; modern color functions use a slash.
export function colorAlpha(color) {
  if (color.trim().toLowerCase() === "transparent") return 0;
  const slash = color.match(/\/\s*([^\s(),/]+)\s*\)$/);
  const legacy = /^(rgba|hsla)\(/i.test(color) && color.includes(",")
    ? color.match(/,\s*([^\s(),/]+)\s*\)$/) : null;
  const alpha = slash?.[1] ?? legacy?.[1];
  if (alpha === undefined) return 1;
  if (alpha.toLowerCase() === "none") return 0;
  return parseFloat(alpha) / (alpha.endsWith("%") ? 100 : 1);
}
