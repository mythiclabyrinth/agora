import {
  filterMapPlaces,
  mapArtifactHtml,
  mapSelectScript,
  mapUpdateScript,
  projectMapPoints,
} from "../src/lib/mapArtifacts";
import type { MapArtifactData } from "@agora/core";
import { themes } from "../src/lib/theme";

const data: MapArtifactData = {
  initial_view: { mode: "fit" },
  regions: [
    { id: "r1", label: "One", center: { lat: 10, lng: 20 }, day_ids: ["d1"] },
  ],
  days: [
    { id: "d1", number: 1, label: "Day", region_id: "r1", place_ids: ["p1"] },
  ],
  places: [
    {
      id: "p1",
      label: "One",
      position: { lat: 10, lng: 20 },
      region_id: "r1",
      day_ids: ["d1"],
      category: "food",
    },
    {
      id: "p2",
      label: "Two",
      position: { lat: 12, lng: 24 },
      region_id: "r2",
      day_ids: ["d2"],
      category: "sight",
    },
  ],
  routes: [
    {
      id: "route",
      kind: "overview",
      place_ids: ["p1", "p2"],
      region_ids: [],
      coordinates: [
        [20, 10],
        [24, 12],
      ],
    },
  ],
};

test.each(["light", "dark"] as const)("map controls and popup text follow %s appearance", mode => {
  const html = mapArtifactHtml(data, "https://example.test/style.json", themes[mode]);
  expect(html).toContain(`background:${themes[mode].colors.bg}`);
  expect(html).toContain(`background:${themes[mode].colors.sheet}; color:${themes[mode].colors.text}`);
});

test("filters places by area, day, and category", () => {
  expect(
    filterMapPlaces(data, { region: "r1", day: "d1", category: "food" }).map(
      (p) => p.id,
    ),
  ).toEqual(["p1"]);
  expect(
    filterMapPlaces(data, { region: "r1", day: "", category: "sight" }),
  ).toEqual([]);
});

test("projection is stable for empty and coincident points", () => {
  expect(projectMapPoints([])).toEqual([]);
  expect(projectMapPoints([{ id: "x", lat: 1, lng: 1 }])).toEqual([
    { id: "x", x: 50, y: 50 },
  ]);
});

test("tile HTML uses the MapLibre module build, preserves GeoJSON, and escapes markup", () => {
  const hostile = "</script><img src=x onerror=alert(1)>";
  const html = mapArtifactHtml(
    { ...data, places: [{ ...data.places[0], label: hostile }] },
    "https://tiles.test/<style>.json",
  );
  expect(html).toContain('type="module"');
  expect(html).toContain("Content-Security-Policy");
  // WebKit needs worker-src/child-src spelled out (no script-src fallback for
  // workers): without them MapLibre's worker dies silently and the map shows
  // tiles but no pins.
  expect(html).toContain(
    "script-src 'unsafe-inline' https://unpkg.com blob:; "
      + "worker-src blob: https://unpkg.com; child-src blob: https://unpkg.com",
  );
  expect(html).toContain("maplibre-gl@6.0.0/dist/maplibre-gl.mjs");
  expect(html).not.toContain("dist/maplibre-gl.js");
  expect(html).toContain("Could not load the map renderer");
  expect(html).toContain("ReactNativeWebView?.postMessage");
  expect(html).toContain("Timed out after 8 seconds");
  expect(html.indexOf("await import")).toBeLessThan(
    html.indexOf("watchdog = setTimeout"),
  );
  expect(html).toContain("duration: 400");
  expect(html).toContain('console.warn("Map resource error"');
  expect(html).not.toContain('map.on("error", (event) => {\n    if');
  expect(html).toContain("(async () => {");
  expect(html).toContain('"coordinates":[[20,10],[24,12]]');
  expect(html).toContain("https://tiles.test/\\u003cstyle>.json");
  expect(html).not.toContain("<style>.json");
  expect(html).not.toContain(hostile);
  expect(html).toContain("\\u003c/script>\\u003cimg src=x onerror=alert(1)>");
});

test("tile HTML carries desktop parity: colors, clusters, chips, popups, dashed route", () => {
  const html = mapArtifactHtml(data, "https://tiles.test/style.json");
  // Day 1 place gets the first shared day color; regions ride along for chips.
  expect(html).toContain('"color":"#5aa0ff"');
  expect(html).toContain('"regions":[{"id":"r1","label":"One"');
  // Same clustering profile as web's supercluster config.
  expect(html).toContain("clusterRadius: 56");
  expect(html).toContain("clusterMaxZoom: 16");
  expect(html).toContain("getClusterExpansionZoom");
  // Dashed route styling matching the desktop canvas.
  expect(html).toContain('"line-dasharray": [2, 1.4]');
  // The RN-driven hooks and interactive affordances.
  expect(html).toContain("window.__agoraUpdate");
  expect(html).toContain("window.__agoraSelect");
  expect(html).toContain('JSON.stringify({ regionId: region.id })');
  expect(html).toContain("popupHtml");
});

test("update injection escapes ids and returns a WebView completion value", () => {
  const script = mapUpdateScript(
    ["p1", "</script><img onerror=alert(1)>"],
    "r1",
  );
  expect(script).toContain('window.__agoraUpdate?.({"ids":["p1"');
  expect(script).toContain('"region":"r1"');
  expect(script).toContain('"fit":true');
  expect(script).toContain("\\u003c/script>\\u003cimg onerror=alert(1)>");
  expect(script).not.toContain("</script>");
  expect(script).toMatch(/true;$/);
});

test("select injection escapes the id and returns a completion value", () => {
  const script = mapSelectScript("</script><img onerror=alert(1)>");
  expect(script).toContain("window.__agoraSelect?.(");
  expect(script).toContain("\\u003c/script>\\u003cimg onerror=alert(1)>");
  expect(script).not.toContain("</script>");
  expect(script).toMatch(/true;$/);
});

test("missing routes default to an empty list", () => {
  const html = mapArtifactHtml(
    { ...data, routes: undefined as unknown as MapArtifactData["routes"] },
    "https://tiles.test/style.json",
  );
  expect(html).toContain('"routes":[]');
});
