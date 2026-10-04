import type {
  MapArtifactData, MapArtifactPlace, MapArtifactRegion,
} from "@agora/core";

type Point = { id: string; label: string; lat: number; lng: number; kind: "region" | "place" };

function pointsOf(data: MapArtifactData, regionId?: string, places?: MapArtifactPlace[]): Point[] {
  if (places) {
    return places.map(p => ({
      id: p.id, label: p.label, lat: p.position.lat, lng: p.position.lng, kind: "place",
    }));
  }
  const regions = regionId ? data.regions.filter(r => r.id === regionId) : data.regions;
  return regions.map(r => ({
    id: r.id, label: r.label, lat: r.center.lat, lng: r.center.lng, kind: "region",
  }));
}

function projection(points: Point[]) {
  const lats = points.map(p => p.lat);
  const lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  return (lat: number, lng: number) => ({
    x: lngSpan < .000001 ? 50 : 8 + ((lng - minLng) / lngSpan) * 84,
    y: latSpan < .000001 ? 50 : 88 - ((lat - minLat) / latSpan) * 76,
  });
}

export function MapGraphic({ data, activeRegion, visiblePlaces, selectedPlace, onRegion, onPlace }: {
  data: MapArtifactData;
  activeRegion?: string;
  visiblePlaces?: MapArtifactPlace[];
  selectedPlace?: string;
  onRegion?: (region: MapArtifactRegion) => void;
  onPlace?: (place: MapArtifactPlace) => void;
}) {
  const detail = visiblePlaces !== undefined;
  const points = pointsOf(data, activeRegion, visiblePlaces);
  const fallback = detail && !points.length ? pointsOf(data, activeRegion) : points;
  if (!fallback.length) return <div className="ago-map-empty">No mappable locations</div>;
  const project = projection(fallback);
  const byRegion = new Map(data.regions.map(r => [r.id, r]));
  const routePoints = detail
    ? visiblePlaces || []
    : data.regions;

  return (
    <svg className="ago-map-graphic" viewBox="0 0 100 100" role="img"
      aria-label="Interactive itinerary map">
      <defs>
        <linearGradient id="ago-map-sea" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="var(--map-sea-start)" />
          <stop offset="1" stopColor="var(--map-sea-end)" />
        </linearGradient>
        <filter id="ago-map-glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect width="100" height="100" rx="4" fill="url(#ago-map-sea)" />
      <path className="ago-map-land" d="M-5 19 Q14 8 30 18T64 16T105 22V92Q86 86 69 93T33 90T-5 94Z" />
      <path className="ago-map-grid" d="M0 30H100M0 55H100M0 80H100M25 0V100M50 0V100M75 0V100" />
      {routePoints.length > 1 && (
        <polyline className="ago-map-route" points={routePoints.map(item => {
          const pos = "position" in item ? item.position : item.center;
          const p = project(pos.lat, pos.lng);
          return `${p.x},${p.y}`;
        }).join(" ")} />
      )}
      {detail
        ? (visiblePlaces || []).map((place, i) => {
          const p = project(place.position.lat, place.position.lng);
          return (
            <g key={place.id} className={`ago-map-marker place ${selectedPlace === place.id ? "selected" : ""}`}
              transform={`translate(${p.x} ${p.y})`} role="button" tabIndex={0}
              aria-label={place.label} onClick={() => onPlace?.(place)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") onPlace?.(place); }}>
              <circle r="4.4" />
              <text y="1.35">{place.order || i + 1}</text>
              <title>{place.label}</title>
            </g>
          );
        })
        : data.regions.map(region => {
          const p = project(region.center.lat, region.center.lng);
          return (
            <g key={region.id} className={`ago-map-marker region ${activeRegion === region.id ? "selected" : ""}`}
              transform={`translate(${p.x} ${p.y})`} role="button" tabIndex={0}
              aria-label={region.label} onClick={() => onRegion?.(region)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") onRegion?.(region); }}>
              <circle r="3.4" />
              <text className="ago-map-label" x="5" y="1.5">{region.label}</text>
            </g>
          );
        })}
      {detail && activeRegion && !visiblePlaces?.length && (() => {
        const region = byRegion.get(activeRegion);
        if (!region) return null;
        const p = project(region.center.lat, region.center.lng);
        return <text className="ago-map-no-results" x={p.x} y={p.y}>No places match</text>;
      })()}
    </svg>
  );
}
