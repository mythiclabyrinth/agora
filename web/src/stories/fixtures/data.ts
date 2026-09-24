import type { MapArtifactData } from "@agora/core";
import {
  fixtureAgentMessage,
  fixtureMe,
} from "@agora/core/testing/fixtures";

export const me = { ...fixtureMe, voice: true, voice_stt: true, voice_transcribe: true };
export const message = { ...fixtureAgentMessage, id: 42 };

export const mapArtifact: MapArtifactData = {
  initial_view: { mode: "fit" },
  regions: [
    { id: "kochi", label: "Kochi", center: { lat: 9.9312, lng: 76.2673 }, day_ids: ["d1"] },
    { id: "munnar", label: "Munnar", center: { lat: 10.0889, lng: 77.0595 }, day_ids: ["d2"] },
    { id: "alleppey", label: "Alleppey", center: { lat: 9.4981, lng: 76.3388 }, day_ids: ["d3"] },
  ],
  days: [],
  places: [],
  routes: [],
};
