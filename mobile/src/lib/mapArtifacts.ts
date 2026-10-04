import {
  colorForPlace,
  type MapArtifactData,
  type MapArtifactPlace,
} from "@agora/core";

import { themes, type AppTheme } from "./theme";

export type MapFilters = { region: string; day: string; category: string };
export type ProjectedPoint = { id: string; x: number; y: number };

export function filterMapPlaces(
  data: MapArtifactData,
  filters: MapFilters,
): MapArtifactPlace[] {
  return data.places.filter(
    (place) =>
      (!filters.region || place.region_id === filters.region) &&
      (!filters.day || place.day_ids.includes(filters.day)) &&
      (!filters.category || place.category === filters.category),
  );
}

export function projectMapPoints(
  points: Array<{ id: string; lat: number; lng: number }>,
): ProjectedPoint[] {
  if (!points.length) return [];
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  return points.map((point) => ({
    id: point.id,
    x: lngSpan < 0.000001 ? 50 : 8 + ((point.lng - minLng) / lngSpan) * 84,
    y: latSpan < 0.000001 ? 50 : 88 - ((point.lat - minLat) / latSpan) * 76,
  }));
}

/* The tile renderer that runs inside the WebView. The CSP needs explicit
   worker-src/child-src entries (blob: for MapLibre's bootstrap blob, the CDN
   for the worker module it imports): WebKit — unlike Chromium — does not fall
   back to script-src for workers here, and without them the worker dies
   silently, leaving a tile background with no pins. Mirrors the desktop
   MapCanvas: day-colored numbered pins with cluster bubbles (MapLibre's
   built-in GeoJSON clustering, same radius/maxZoom as web's supercluster),
   labelled area chips that focus a region filter, tap popups, a dashed route
   line, and desktop's fit rules (visible places, else the active region, else
   all regions). The document is built once per artifact; React Native drives
   it through the injected __agoraUpdate/__agoraSelect hooks so filter changes
   never reload the WebView. */
export function mapArtifactHtml(
  data: MapArtifactData,
  styleUrl: string,
  theme: AppTheme = themes.dark,
): string {
  const days = data.days ?? [];
  const payload = JSON.stringify({
    places: data.places.map((place, index) => ({
      id: place.id,
      label: place.label,
      lng: place.position.lng,
      lat: place.position.lat,
      order: place.order ?? index + 1,
      category: place.category,
      start_time: place.start_time ?? "",
      color: colorForPlace(place, data),
      days: place.day_ids
        .map((id) => days.find((day) => day.id === id)?.number)
        .filter((number): number is number => typeof number === "number"),
    })),
    regions: data.regions.map((region) => ({
      id: region.id,
      label: region.label,
      lng: region.center.lng,
      lat: region.center.lat,
    })),
    routes: (data.routes ?? [])
      .filter((route) => route.coordinates.length > 1)
      .map((route) => ({ coordinates: route.coordinates })),
  }).replace(/</g, "\\u003c");
  const style = JSON.stringify(styleUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="script-src 'unsafe-inline' https://unpkg.com blob:; worker-src blob: https://unpkg.com; child-src blob: https://unpkg.com">
<link href="https://unpkg.com/maplibre-gl@6.0.0/dist/maplibre-gl.css" rel="stylesheet">
<style>
html,body,#map { margin:0; width:100%; height:100%; background:${theme.colors.bg}; }
button { cursor:pointer; }
.pin { display:grid; place-items:center; width:24px; height:24px; padding:0;
       border:2px solid #fff; border-radius:999px 999px 999px 2px;
       background:var(--marker,${theme.colors.a1}); color:#fff; font:800 11px/1 system-ui;
       box-shadow:0 2px 6px rgba(0,0,0,.45); transform:rotate(45deg); }
.pin span { transform:rotate(-45deg); }
.pin.selected { transform:rotate(45deg) scale(1.18); border-color:${theme.colors.a1}; z-index:2; }
.cluster { display:grid; place-items:center; min-width:30px; height:30px; padding:0 6px;
           border:2px solid #fff; border-radius:999px; background:${theme.colors.a1}; color:${theme.colors.onAccent};
           font:800 12px/1 system-ui; box-shadow:0 2px 8px rgba(0,0,0,.5); }
.area { max-width:180px; overflow:hidden; padding:4px 9px;
        border:1px solid ${theme.colors.borderStrong}; border-radius:999px;
        background:${theme.colors.sheet}; color:${theme.colors.text};
        font:700 10.5px/1.2 system-ui; text-overflow:ellipsis; white-space:nowrap;
        box-shadow:0 2px 8px rgba(0,0,0,.45); }
.area.selected { border-color:${theme.colors.a1}; background:${theme.colors.a1}; color:${theme.colors.onAccent}; }
.popup-holder .maplibregl-popup-content { padding:9px 11px; border-radius:10px;
  background:${theme.colors.sheet}; color:${theme.colors.text}; box-shadow:0 6px 22px rgba(0,0,0,.5); }
.popup-holder .maplibregl-popup-tip { border-top-color:${theme.colors.sheet}; border-bottom-color:${theme.colors.sheet}; }
.popup strong { display:block; font-size:12px; }
.popup .meta { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
.popup .meta span { border-radius:999px; padding:2px 6px; color:${theme.colors.dim};
                    background:${theme.colors.neutralSoft}; font-size:9px; }
.popup .meta .day { color:${theme.colors.a1}; font-weight:700; }
#err { color:${theme.colors.red}; font:12px ui-monospace,monospace; padding:16px;
       white-space:pre-wrap; overflow-wrap:anywhere; }
</style></head><body><div id="map"></div>
<script type="module">
const data = ${payload};
const holder = document.getElementById("map");
let watchdog;
const reportError = (prefix, error) => {
  clearTimeout(watchdog);
  const detail = String(error?.message || error || "Unknown map error");
  window.ReactNativeWebView?.postMessage(JSON.stringify({ error: detail }));
  const message = document.createElement("div");
  message.id = "err";
  message.textContent = prefix + "\\n\\n" + detail;
  holder.replaceChildren(message);
};
(async () => {
  // This CDN keeps the renderer aligned with web's MapLibre major version;
  // operators still control the separate tile/style endpoint.
  const imported = await import("https://unpkg.com/maplibre-gl@6.0.0/dist/maplibre-gl.mjs");
  watchdog = setTimeout(
    () => reportError("The map renderer did not finish loading.", "Timed out after 8 seconds"),
    8000,
  );
  const maplibregl = imported.default || imported;
  const map = new maplibregl.Map({ container: holder, style: ${style}, dragRotate: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  map.on("error", (event) => {
    console.warn("Map resource error", event?.error || event);
  });

  const byId = new Map(data.places.map((place) => [place.id, place]));
  const state = {
    ids: data.places.map((place) => place.id),
    region: "",
    selected: "",
  };
  const pointEls = new Map();
  const areaEls = new Map();
  const shownMarkers = [];
  let popup = null;

  const esc = (text) => String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const popupHtml = (place) => {
    const chips = (place.days || [])
      .map((number) => '<span class="day">Day ' + esc(number) + "</span>")
      .join("");
    const time = place.start_time ? "<span>" + esc(place.start_time) + "</span>" : "";
    return '<div class="popup"><strong>' + esc(place.label) + "</strong>"
      + '<div class="meta">' + chips + time
      + "<span>" + esc(place.category) + "</span></div></div>";
  };

  const showPopup = (place) => {
    popup?.remove();
    popup = new maplibregl.Popup({
      closeButton: false, closeOnClick: true, offset: 18,
      className: "popup-holder", maxWidth: "260px",
    })
      .setLngLat([place.lng, place.lat])
      .setHTML(popupHtml(place))
      .addTo(map);
  };

  const featureCollection = () => {
    const visible = new Set(state.ids);
    return {
      type: "FeatureCollection",
      features: data.places
        .filter((place) => visible.has(place.id))
        .map((place) => ({
          type: "Feature",
          properties: {
            id: place.id, color: place.color, order: place.order, label: place.label,
          },
          geometry: { type: "Point", coordinates: [place.lng, place.lat] },
        })),
    };
  };

  const applySelected = () => pointEls.forEach((el, id) =>
    el.classList.toggle("selected", id === state.selected));

  // DOM markers rebuilt from the clustered source whenever the viewport or the
  // visible set changes — the same render loop the desktop canvas runs.
  const render = () => {
    shownMarkers.forEach((marker) => marker.remove());
    shownMarkers.length = 0;
    pointEls.clear();
    const seen = new Set();
    for (const feature of map.querySourceFeatures("places")) {
      const props = feature.properties;
      const key = props.cluster ? "c" + props.cluster_id : "p" + props.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const [lng, lat] = feature.geometry.coordinates;
      const el = document.createElement("button");
      el.type = "button";
      if (props.cluster) {
        el.className = "cluster";
        el.textContent = String(props.point_count);
        el.setAttribute("aria-label", props.point_count + " places");
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          map.getSource("places").getClusterExpansionZoom(props.cluster_id)
            .then((zoom) => map.easeTo({
              center: [lng, lat], zoom: Math.min(zoom, 16), duration: 400,
            }))
            .catch(() => {});
        });
      } else {
        el.className = "pin" + (props.id === state.selected ? " selected" : "");
        el.style.setProperty("--marker", props.color);
        const label = document.createElement("span");
        label.textContent = String(props.order);
        el.appendChild(label);
        el.setAttribute("aria-label", props.label);
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          state.selected = props.id;
          applySelected();
          const place = byId.get(props.id);
          if (place) showPopup(place);
          window.ReactNativeWebView?.postMessage(JSON.stringify({ placeId: props.id }));
        });
        pointEls.set(props.id, el);
      }
      shownMarkers.push(
        new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map),
      );
    }
    applySelected();
  };

  // Desktop's fit rules: visible places, else the focused region, else all
  // regions; a single point centers instead of degenerate bounds.
  const fitView = () => {
    const visible = new Set(state.ids);
    let coords = data.places
      .filter((place) => visible.has(place.id))
      .map((place) => [place.lng, place.lat]);
    if (!coords.length) {
      const regions = state.region
        ? data.regions.filter((region) => region.id === state.region)
        : data.regions;
      coords = regions.map((region) => [region.lng, region.lat]);
    }
    if (!coords.length) return;
    if (coords.length === 1) {
      map.easeTo({ center: coords[0], zoom: 12, duration: 400 });
      return;
    }
    const bounds = coords.reduce(
      (value, coord) => value.extend(coord),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    );
    map.fitBounds(bounds, { padding: 45, maxZoom: 14, duration: 400 });
  };

  window.__agoraUpdate = (next) => {
    state.ids = next.ids || [];
    state.region = next.region || "";
    map.getSource("places")?.setData(featureCollection());
    areaEls.forEach((el, id) => el.classList.toggle("selected", id === state.region));
    popup?.remove();
    popup = null;
    if (next.fit !== false) fitView();
    render();
  };
  window.__agoraSelect = (id) => {
    state.selected = id || "";
    applySelected();
  };

  map.on("load", () => {
    clearTimeout(watchdog);
    map.addSource("routes", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: data.routes.map((route) => ({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: route.coordinates },
        })),
      },
    });
    map.addLayer({
      id: "routes",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#5aa0ff",
        "line-width": 2.5,
        "line-opacity": 0.85,
        "line-dasharray": [2, 1.4],
      },
    });
    // Same clustering profile as the desktop canvas's supercluster.
    map.addSource("places", {
      type: "geojson",
      data: featureCollection(),
      cluster: true,
      clusterRadius: 56,
      clusterMaxZoom: 16,
    });
    // An invisible layer forces the source to load so querySourceFeatures
    // (which drives the DOM markers) has clusters to report.
    map.addLayer({
      id: "places-load",
      type: "circle",
      source: "places",
      paint: { "circle-radius": 0, "circle-opacity": 0 },
    });
    data.regions.forEach((region) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "area";
      el.textContent = region.label;
      el.setAttribute("aria-label", "Focus " + region.label);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        window.ReactNativeWebView?.postMessage(JSON.stringify({ regionId: region.id }));
      });
      areaEls.set(region.id, el);
      new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -6] })
        .setLngLat([region.lng, region.lat])
        .addTo(map);
    });
    map.on("moveend", render);
    map.on("sourcedata", (event) => {
      if (event.sourceId === "places" && event.isSourceLoaded) render();
    });
    fitView();
    render();
    window.ReactNativeWebView?.postMessage(JSON.stringify({ ready: true }));
  });
})().catch((error) => reportError("Could not load the map renderer.", error));
</script></body></html>`;
}

/* Injected on filter/reset changes: swaps the visible set, highlights the
   focused area chip, and (by default) re-fits the camera — so "Reset view"
   recalibrates even when the filters were already clear. */
export function mapUpdateScript(
  placeIds: string[],
  regionId: string,
  fit = true,
): string {
  const next = JSON.stringify({ ids: placeIds, region: regionId, fit })
    .replace(/</g, "\\u003c");
  return `window.__agoraUpdate?.(${next}); true;`;
}

/* Injected when the place selection changes so the matching pin highlights. */
export function mapSelectScript(placeId: string): string {
  const id = JSON.stringify(placeId).replace(/</g, "\\u003c");
  return `window.__agoraSelect?.(${id}); true;`;
}
