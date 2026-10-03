import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, {
  Circle,
  Line,
  Polyline,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import { Map as MapIcon, Maximize2, X } from "lucide-react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";
import {
  formatDuration,
  googleMapsDirectionsUrl,
  googleMapsPlaceUrl,
  isMapArtifactV1,
  useMe,
  type MapArtifactData,
  type MapArtifactPlace,
  type MapMessageArtifact,
  type MessageArtifact,
} from "@agora/core";
import { colors } from "../lib/theme";
import {
  filterMapPlaces,
  mapArtifactHtml,
  mapSelectScript,
  mapUpdateScript,
  projectMapPoints,
  type MapFilters,
} from "../lib/mapArtifacts";
import { openLink } from "../lib/openLink";
import { Icon } from "./Icon";

const EMPTY_FILTERS: MapFilters = { region: "", day: "", category: "" };

function CoordinateMap({
  data,
  places,
  selected,
  onPlace,
  activeRegion,
}: {
  data: MapArtifactData;
  places?: MapArtifactPlace[];
  selected?: string;
  onPlace?: (place: MapArtifactPlace) => void;
  activeRegion?: string;
}) {
  const detail = places !== undefined;
  const plottedPlaces = detail
    ? places
    : data.regions.length
      ? []
      : data.places;
  const visibleRegions = activeRegion
    ? data.regions.filter((region) => region.id === activeRegion)
    : data.regions;
  const plottedRegions =
    plottedPlaces.length === 0 && visibleRegions.length > 0;
  const source = plottedRegions
    ? visibleRegions.map((region) => ({
        id: region.id,
        lat: region.center.lat,
        lng: region.center.lng,
      }))
    : plottedPlaces.map((place) => ({
        id: place.id,
        lat: place.position.lat,
        lng: place.position.lng,
      }));
  const projected = projectMapPoints(source);
  const byId = new Map(projected.map((point) => [point.id, point]));
  if (!projected.length)
    return (
      <View style={styles.empty}>
        <Text style={styles.dim}>No mappable locations</Text>
      </View>
    );
  return (
    <Svg
      testID="coordinate-map"
      viewBox="0 0 100 100"
      style={styles.svg}
      accessibilityLabel="Itinerary map"
    >
      <Rect width="100" height="100" rx="4" fill="#0b1220" />
      {[25, 50, 75].map((n) => (
        <Line
          key={`h${n}`}
          x1="0"
          x2="100"
          y1={n}
          y2={n}
          stroke="#283348"
          strokeWidth=".35"
        />
      ))}
      {[25, 50, 75].map((n) => (
        <Line
          key={`v${n}`}
          y1="0"
          y2="100"
          x1={n}
          x2={n}
          stroke="#283348"
          strokeWidth=".35"
        />
      ))}
      {projected.length > 1 ? (
        <Polyline
          points={projected.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke="#5aa0ff"
          strokeWidth="1.5"
          strokeDasharray="3 2"
        />
      ) : null}
      {!plottedRegions
        ? plottedPlaces.map((place, index) => {
            const point = byId.get(place.id);
            if (!point) return null;
            return (
              <React.Fragment key={place.id}>
                <Circle
                  cx={point.x}
                  cy={point.y}
                  r={selected === place.id ? 5 : 4}
                  fill={selected === place.id ? colors.a2 : colors.a1}
                  onPress={() => onPlace?.(place)}
                  accessibilityLabel={place.label}
                />
                <SvgText
                  x={point.x}
                  y={point.y + 1.5}
                  textAnchor="middle"
                  fill="#071019"
                  fontSize="4"
                  fontWeight="700"
                >
                  {place.order ?? index + 1}
                </SvgText>
              </React.Fragment>
            );
          })
        : visibleRegions.map((region) => {
            const point = byId.get(region.id);
            if (!point) return null;
            return (
              <React.Fragment key={region.id}>
                <Circle
                  cx={point.x}
                  cy={point.y}
                  r="3"
                  fill={colors.a2}
                  accessibilityLabel={region.label}
                />
                <SvgText
                  x={point.x + 5}
                  y={point.y + 1.5}
                  fill={colors.text}
                  fontSize="4"
                >
                  {region.label}
                </SvgText>
              </React.Fragment>
            );
          })}
      {detail && !places.length && data.places.length ? (
        <SvgText
          x="50"
          y="96"
          textAnchor="middle"
          fill={colors.dim}
          fontSize="4"
        >
          No places match
        </SvgText>
      ) : null}
    </Svg>
  );
}

function FilterChips({
  label,
  values,
  value,
  onChange,
}: {
  label: string;
  values: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <View style={styles.filterRow}>
      <Text style={styles.filterLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        <Pressable
          accessibilityRole="button"
          style={[styles.chip, !value && styles.chipOn]}
          onPress={() => onChange("")}
        >
          <Text style={styles.chipText}>All</Text>
        </Pressable>
        {values.map((item) => (
          <Pressable
            accessibilityRole="button"
            key={item.id}
            style={[styles.chip, value === item.id && styles.chipOn]}
            onPress={() => onChange(item.id)}
          >
            <Text style={styles.chipText}>{item.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export function MapViewer({
  artifact,
  initialRegion,
  onClose,
}: {
  artifact: MapMessageArtifact;
  initialRegion?: string;
  onClose: () => void;
}) {
  const { data } = artifact;
  const styleUrl = useMe().data?.map_style_url?.trim() || "";
  const [filters, setFilters] = useState<MapFilters>({
    ...EMPTY_FILTERS,
    region: initialRegion || "",
  });
  const [selectedId, setSelectedId] = useState("");
  const [mapFailed, setMapFailed] = useState(false);
  const [refitNonce, setRefitNonce] = useState(0);
  const mapRef = useRef<WebView>(null);
  const places = useMemo(() => filterMapPlaces(data, filters), [data, filters]);
  const days = (data.days ?? []).filter(
    (day) => !filters.region || day.region_id === filters.region,
  );
  const categories = [
    ...new Set(
      data.places
        .filter(
          (place) => !filters.region || place.region_id === filters.region,
        )
        .map((place) => place.category),
    ),
  ];
  useEffect(() => {
    if (filters.day && !days.some((day) => day.id === filters.day))
      setFilters((old) => ({ ...old, day: "" }));
    if (
      filters.category &&
      !categories.some((category) => category === filters.category)
    )
      setFilters((old) => ({ ...old, category: "" }));
  }, [filters.region]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setMapFailed(false), [styleUrl]);
  const detail =
    places.find((place) => place.id === selectedId) ?? places[0] ?? null;
  const mapHtml = useMemo(
    () => (styleUrl ? mapArtifactHtml(data, styleUrl) : ""),
    [data, styleUrl],
  );
  const mapSource = useMemo(
    () => ({ html: mapHtml, baseUrl: "https://unpkg.com/" }),
    [mapHtml],
  );
  useEffect(() => {
    if (!styleUrl || mapFailed) return;
    mapRef.current?.injectJavaScript(
      mapUpdateScript(places.map((place) => place.id), filters.region),
    );
  }, [mapFailed, places, filters.region, refitNonce, styleUrl]);
  useEffect(() => {
    if (!styleUrl || mapFailed) return;
    mapRef.current?.injectJavaScript(mapSelectScript(selectedId));
  }, [mapFailed, selectedId, styleUrl]);
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={styles.modal}>
        <View style={styles.modalHead}>
          <Icon icon={MapIcon} size={16} color={colors.a2} />
          <Text style={styles.modalTitle} numberOfLines={1}>
            {artifact.title}
          </Text>
          <Pressable accessibilityLabel="Close map" onPress={onClose}>
            <Icon icon={X} size={22} color={colors.dim} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.viewer}>
          <FilterChips
            label="Area"
            value={filters.region}
            values={data.regions.map((r) => ({ id: r.id, label: r.label }))}
            onChange={(region) => setFilters((old) => ({ ...old, region }))}
          />
          <FilterChips
            label="Day"
            value={filters.day}
            values={days.map((d) => ({
              id: d.id,
              label: `${d.number} · ${d.label}`,
            }))}
            onChange={(day) => setFilters((old) => ({ ...old, day }))}
          />
          <FilterChips
            label="Category"
            value={filters.category}
            values={categories.map((c) => ({ id: c, label: c }))}
            onChange={(category) => setFilters((old) => ({ ...old, category }))}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setFilters(EMPTY_FILTERS);
              setRefitNonce((value) => value + 1);
            }}
          >
            <Text style={styles.reset}>Reset view</Text>
          </Pressable>
          <View style={styles.mapFrame}>
            {styleUrl &&
            (data.places.length || data.regions.length) &&
            !mapFailed ? (
              <WebView
                ref={mapRef}
                testID="tile-map"
                // react-native-webview matches whitelist patterns against the
                // request's *origin* ("https://unpkg.com" — no trailing
                // slash), so "https://unpkg.com/*" can never match: the
                // library would cancel the initial document load (empty map)
                // and push the base URL into Safari. Keep this origin-shaped.
                originWhitelist={["https://unpkg.com"]}
                source={mapSource}
                onShouldStartLoadWithRequest={(request: WebViewNavigation) => {
                  // Only the initial document (about:blank rendered against
                  // the unpkg base URL) may load inside the WebView. Any
                  // in-page navigation — attribution links, unexpected
                  // redirects — opens in the system browser instead of
                  // replacing the map with that page.
                  if (
                    request.url === "about:blank" ||
                    request.url === "https://unpkg.com/"
                  )
                    return true;
                  if (/^https?:\/\//.test(request.url))
                    void openLink(request.url);
                  return false;
                }}
                style={styles.web}
                onMessage={(event) => {
                  try {
                    const message = JSON.parse(event.nativeEvent.data);
                    if (typeof message.error === "string") {
                      setMapFailed(true);
                    } else if (message.ready === true) {
                      mapRef.current?.injectJavaScript(
                        mapUpdateScript(
                          places.map((place) => place.id),
                          filters.region,
                        ),
                      );
                      if (selectedId)
                        mapRef.current?.injectJavaScript(
                          mapSelectScript(selectedId),
                        );
                    } else if (typeof message.regionId === "string") {
                      setFilters((old) => ({
                        ...old,
                        region:
                          old.region === message.regionId
                            ? ""
                            : message.regionId,
                      }));
                    } else if (typeof message.placeId === "string") {
                      setSelectedId(message.placeId);
                    }
                  } catch {
                    /* ignore untrusted messages */
                  }
                }}
              />
            ) : (
              <CoordinateMap
                data={data}
                places={places}
                selected={selectedId}
                onPlace={(place) => setSelectedId(place.id)}
                activeRegion={filters.region || undefined}
              />
            )}
          </View>
          {detail ? (
            <View style={styles.details}>
              <Text style={styles.category}>{detail.category}</Text>
              <Text style={styles.placeTitle}>{detail.label}</Text>
              <Text style={styles.dim}>
                {[detail.start_time, formatDuration(detail.duration_minutes)]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {detail.description ? (
                <Text style={styles.body}>{detail.description}</Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  onPress={() => void openLink(googleMapsPlaceUrl(detail))}
                >
                  <Text style={styles.link}>Open in Google Maps</Text>
                </Pressable>
                <Pressable
                  onPress={() => void openLink(googleMapsDirectionsUrl(detail))}
                >
                  <Text style={styles.link}>Directions</Text>
                </Pressable>
              </View>
              {places.map((place) => (
                <Pressable
                  key={place.id}
                  style={[
                    styles.placeRow,
                    selectedId === place.id && styles.placeOn,
                  ]}
                  onPress={() => setSelectedId(place.id)}
                >
                  <Text style={styles.placeNum}>{place.order ?? "•"}</Text>
                  <Text style={styles.body}>{place.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.placeTitle}>
                {data.places.length
                  ? "No places match these filters"
                  : "No individual places pinned"}
              </Text>
              <Text style={styles.dim}>
                {data.places.length
                  ? "Change a filter or reset the view."
                  : "This map marks areas only."}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

export function MapArtifactCard({
  artifact,
}: {
  artifact: MapMessageArtifact;
}) {
  const [openRegion, setOpenRegion] = useState<string | null>(null);
  const { data } = artifact;
  return (
    <>
      <View style={styles.card}>
        <Pressable
          accessibilityLabel={`Open ${artifact.title}`}
          onPress={() => setOpenRegion("")}
        >
          <View style={styles.cardHead}>
            <View style={styles.grow}>
              <Text style={styles.kicker}>Interactive map</Text>
              <Text style={styles.title}>{artifact.title}</Text>
              {artifact.summary ? (
                <Text style={styles.dim}>{artifact.summary}</Text>
              ) : null}
            </View>
            <Icon icon={Maximize2} size={17} color={colors.a1} />
          </View>
          <View style={styles.preview}>
            <CoordinateMap data={data} />
          </View>
        </Pressable>
        <View style={styles.cardFoot}>
          <Text style={styles.dim}>
            {data.regions.length} areas · {data.places.length} places
          </Text>
          <View style={styles.chips}>
            {data.regions.map((region) => (
              <Pressable
                key={region.id}
                style={styles.chip}
                onPress={() => setOpenRegion(region.id)}
              >
                <Text style={styles.chipText}>{region.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
      {openRegion !== null ? (
        <MapViewer
          artifact={artifact}
          initialRegion={openRegion || undefined}
          onClose={() => setOpenRegion(null)}
        />
      ) : null}
    </>
  );
}

export function ArtifactList({ artifacts }: { artifacts?: MessageArtifact[] }) {
  if (!artifacts?.length) return null;
  return (
    <View style={styles.list}>
      {artifacts.map((artifact) =>
        isMapArtifactV1(artifact) ? (
          <MapArtifactCard key={artifact.id} artifact={artifact} />
        ) : (
          <View key={artifact.id} style={styles.unsupported}>
            <Text style={styles.kicker}>{artifact.type} artifact</Text>
            <Text style={styles.title}>{artifact.title}</Text>
            <Text style={styles.dim}>
              This version of Agora cannot display this artifact.
            </Text>
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8, marginTop: 7 },
  card: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#0b0f18",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
  },
  grow: { flex: 1, gap: 3 },
  kicker: {
    color: colors.a2,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  title: { color: colors.text, fontSize: 14, fontWeight: "700" },
  preview: { height: 150 },
  svg: { width: "100%", height: "100%" },
  cardFoot: { padding: 10, gap: 7 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.panelStrong,
  },
  chipOn: { borderColor: colors.a1, backgroundColor: colors.accentSoft },
  chipText: { color: colors.text, fontSize: 11 },
  unsupported: {
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    gap: 4,
  },
  modal: { flex: 1, backgroundColor: colors.bg, paddingTop: 52 },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700" },
  viewer: { padding: 14, paddingBottom: 40, gap: 10 },
  filterRow: { gap: 5 },
  filterLabel: {
    color: colors.dim,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  reset: {
    color: colors.a1,
    fontSize: 12,
    fontWeight: "700",
    alignSelf: "flex-end",
  },
  mapFrame: {
    height: 330,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  web: { flex: 1, backgroundColor: "#0b1220" },
  details: {
    gap: 8,
    padding: 13,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
  },
  category: {
    color: colors.a2,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  placeTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  body: { color: colors.text, fontSize: 13 },
  dim: { color: colors.dim, fontSize: 12 },
  actions: { flexDirection: "row", gap: 18 },
  link: { color: colors.a1, fontSize: 12, fontWeight: "700" },
  placeRow: { flexDirection: "row", gap: 9, padding: 8, borderRadius: 7 },
  placeOn: { backgroundColor: colors.accentSoft },
  placeNum: { color: colors.a2, width: 18, fontWeight: "800" },
  empty: {
    minHeight: 100,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    gap: 5,
  },
});
