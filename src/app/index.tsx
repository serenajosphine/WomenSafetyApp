import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAudioPlayer } from "expo-audio";
import { BlurView } from "expo-blur";
import * as Location from "expo-location";
import * as SMS from "expo-sms";
import { useEffect, useMemo, useRef, useState } from "react";
import { Callout, CalloutSubview } from "react-native-maps";

import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View
} from "react-native";

import MapView, {
  Marker,
  Polyline,
  Region,
} from "react-native-maps";

/* ============================================================
   LOGO
============================================================ */

const SECURIA_LOGO = require(
  "../../assets/securia-logo.png"
);

// Lumi's character icon used in the bottom taskbar.
const LUMI_ICON = require("./lumi_icon.png");

/* ============================================================
   COLORS
============================================================ */

const COLORS = {
  background: "#2A0004",
  card: "#360006",
  cardBorder: "#711425",

  gold: "#F2C76B",
  goldLight: "#E6C978",
  goldBorder: "#D6AF55",

  cream: "#F8EEF0",
  creamText: "#7B7072",
  darkText: "#210006",


  green: "#59E58B",
  greenBg: "#172D1B",

  pink: "#F06B9A",
  pinkLight: "#F58EB1",

  red: "#FF5864",
  redBg: "#3A0710",

  white: "#FFFFFF",
};

// Update this LAN address if the backend computer receives a new IP.
const API_BASE_URL = "http://192.168.0.3:3000/api";


/* ============================================================
   TYPES
============================================================ */

type Point = {
  latitude: number;
  longitude: number;
};

type GeoPoint = Point & {
  displayName: string;
};

type RouteData = {
  id: string;
  coordinates: Point[];
  distanceKm: number;
  durationMin: number;
  riskScore?: number;
  safetyScore?: number;
  safetyReady?: boolean;
  safetyDetails?: any;
  isSimulated?: boolean;
};

type NearbyPlace = {
  name: string;
  type: string;
  distanceKm: number;
  latitude?: number;
  longitude?: number;
};

type RiskLocation = {
  id: string | number;
  location_name?: string;
  name?: string;
  latitude: number;
  longitude: number;
  category?: string;
  reason?: string;
  risk_level?: string;
};

type HistoricalLocation = {
  id: string | number;
  name: string;
  latitude: number;
  longitude: number;
  reason?: string;
  category?: string;
};

type RouteKind =
  | "safer"
  | "fastest"
  | "riskier";

// Keeps the most recently generated route alive even when the Explore
// screen is temporarily unmounted while the user visits Home, SOS,
// Profile, or Lumi. A new start/destination pair gets a fresh route.
type RouteSessionCache = {
  key: string;
  start: GeoPoint;
  destination: GeoPoint;
  routes: RouteData[];
  nearbyPlaces: NearbyPlace[];
  selectedRoute: RouteKind;
};

let routeSessionCache: RouteSessionCache | null = null;

type AppTab = "Home" | "Explore" | "SOS" | "Profile";

type EmergencyContact = {
  id: string;
  name: string;
  relation: string;
  phone: string;
  primary: boolean;
};

type UserProfile = {
  name: string;
  phone: string;
  email: string;
};

const CONTACTS_STORAGE_KEY = "securia_emergency_contacts_v1";
const PROFILE_STORAGE_KEY = "securia_profile_v1";

const DEFAULT_PROFILE: UserProfile = {
  name: "",
  phone: "",
  email: "",
};

/* ============================================================
   GEOCODING
============================================================ */

async function geocode(
  place: string
): Promise<GeoPoint | null> {
  const query = `${place.trim()}, India`;

  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=" +
    encodeURIComponent(query);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "SecuriaSafetyApp/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      "Location search failed."
    );
  }

  const data =
    await response.json();

  if (!data?.length) {
    return null;
  }

  return {
    latitude: Number(
      data[0].lat
    ),
    longitude: Number(
      data[0].lon
    ),
    displayName:
      data[0].display_name,
  };
}

/* ============================================================
   ROUTING
============================================================ */

function routeSignature(coordinates: Point[]): string {
  return coordinates
    .filter((_, index) => index % Math.max(1, Math.floor(coordinates.length / 30)) === 0)
    .map(
      (point) =>
        `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`
    )
    .join("|");
}

function pointDistanceMeters(a: Point, b: Point): number {
  return (
    getDistanceKm(
      a.latitude,
      a.longitude,
      b.latitude,
      b.longitude
    ) * 1000
  );
}

/*
  Two routes are considered different only when their sampled
  road geometry separates by roughly 25 metres or more. This
  prevents the UI from treating tiny geometry variations as
  three different routes.
*/


function routesAreDifferent(
  a: Point[],
  b: Point[]
): boolean {
  if (a.length < 2 || b.length < 2) return false;

  const sample = (points: Point[]): Point[] => {
    const count = Math.min(30, points.length);

    return Array.from({ length: count }, (_, index) => {
      const position = Math.round(
        (index / (count - 1)) * (points.length - 1)
      );
      return points[position];
    });
  };

  const aSamples = sample(a);
  const bSamples = sample(b);

  const fractionAway = (from: Point[], to: Point[]) => {
    const differentPoints = from.filter((point) => {
      const nearestDistance = Math.min(
        ...to.map((other) => pointDistanceMeters(point, other))
      );

      return nearestDistance > 35;
    });

    return differentPoints.length / from.length;
  };

  const aToB = fractionAway(aSamples, bSamples);
  const bToA = fractionAway(bSamples, aSamples);

  // A meaningful part of the routes must use different road geometry.
  return Math.max(aToB, bToA) >= 0.20;
}



async function getValhallaRoutes(
  start: GeoPoint,
  destination: GeoPoint,
  usePrimary = 0.5,
  useLit = 0
): Promise<RouteData[]> {
  const response = await fetchWithTimeout(
  "https://valhalla1.openstreetmap.de/route",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": "securia-safety-app",
    },
    body: JSON.stringify({
      locations: [
        {
          lat: start.latitude,
          lon: start.longitude,
          type: "break",
        },
        {
          lat: destination.latitude,
          lon: destination.longitude,
          type: "break",
        },
      ],
      costing: "auto",
      alternates: 2,
      units: "kilometers",
      format: "osrm",
      shape_format: "geojson",
      directions_type: "none",
      costing_options: {
        auto: {
          use_primary: usePrimary,
          use_lit: useLit,
        },
      },
    }),
  },
  10000
);

  if (!response.ok) return [];

  const data = await response.json();
  if (!data?.routes?.length) return [];

  return data.routes
    .map((route: any): RouteData | null => {
      const coordinates: Point[] =
        route.geometry?.coordinates?.map(
          ([longitude, latitude]: [number, number]) => ({
            latitude,
            longitude,
          })
        ) || [];

      if (coordinates.length < 2) return null;

      return {
        id: "valhalla-route",
        coordinates,
        // Valhalla's OSRM-compatible response reports route.distance
        // in METRES. Convert it to kilometres before the UI formats it.
        // This prevents values such as 3338.4 km when the real route is
        // about 3.34 km.
        distanceKm: Number(route.distance) / 1000,
        durationMin: Math.max(
          1,
          Math.round(Number(route.duration) / 60)
        ),
        safetyReady: false,
      };
    })
    .filter(Boolean) as RouteData[];
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 9000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}



function makeSimulatedRoute(
  start: GeoPoint,
  destination: GeoPoint,
  offsetMeters: number,
  id: string
): RouteData {
  // These curved paths are for the visual prototype only. They are
  // deliberately not represented as verified road directions.
  const averageLatitude =
    ((start.latitude + destination.latitude) / 2) *
    (Math.PI / 180);

  const deltaLat = destination.latitude - start.latitude;
  const deltaLon = destination.longitude - start.longitude;
  const length = Math.sqrt(
    (deltaLat * 111320) ** 2 +
    (deltaLon * 111320 * Math.cos(averageLatitude)) ** 2
  );

  const safeLength = Math.max(length, 1);
  const perpendicularLat = -(deltaLon * 111320 * Math.cos(averageLatitude)) / safeLength;
  const perpendicularLon =
    (deltaLat * 111320) /
    safeLength /
    Math.max(0.2, Math.cos(averageLatitude));

  const coordinates: Point[] = Array.from(
    { length: 9 },
    (_, index) => {
      const t = index / 8;
      const curve = Math.sin(Math.PI * t) * offsetMeters;
      return {
        latitude:
          start.latitude +
          deltaLat * t +
          (perpendicularLat * curve) / 111320,
        longitude:
          start.longitude +
          deltaLon * t +
          (perpendicularLon * curve) / 111320,
      };
    }
  );

  let distanceKm = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    distanceKm += getDistanceKm(
      coordinates[index].latitude,
      coordinates[index].longitude,
      coordinates[index + 1].latitude,
      coordinates[index + 1].longitude
    );
  }

  return {
    id,
    coordinates,
    distanceKm,
    durationMin: Math.max(1, Math.round((distanceKm / 25) * 60)),
    safetyReady: false,
    isSimulated: true,
    safetyDetails: {
      source: "Simulated prototype geometry",
      note: "Visual route only. This is not a verified road route and must not be used for real-world navigation or safety decisions.",
    },
  };
}

async function getRoutes(
  start: GeoPoint,
  destination: GeoPoint
): Promise<RouteData[]> {
  const candidates: RouteData[] = [];

  const addCandidate = (candidate: RouteData) => {
    if (
      candidate.coordinates.length < 2 ||
      !Number.isFinite(candidate.distanceKm) ||
      !Number.isFinite(candidate.durationMin)
    ) {
      return;
    }

    const duplicate = candidates.some((existing) =>
      !routesAreDifferent(existing.coordinates, candidate.coordinates)
    );

    if (!duplicate) {
      candidate.id = `route-${candidates.length + 1}`;
      candidates.push(candidate);
    }
  };

  // First collect genuine road alternatives from Valhalla.
  const preferences = [
    { primary: 0.2, lit: 0 },
    { primary: 0.8, lit: 0.8 },
  ];

  const valhallaResults = await Promise.allSettled(
    preferences.map(({ primary, lit }) =>
      getValhallaRoutes(start, destination, primary, lit)
    )
  );

  valhallaResults.forEach((result) => {
    if (result.status === "fulfilled") {
      result.value.forEach(addCandidate);
    } else {
      console.warn("Valhalla route failed:", result.reason);
    }
  });

  // Ask OSRM for additional genuine alternatives if fewer than three exist.
  if (candidates.length < 3) {
    const base =
      "https://router.project-osrm.org/route/v1/driving/" +
      `${start.longitude},${start.latitude};${destination.longitude},${destination.latitude}`;

    try {
      const response = await fetchWithTimeout(
        `${base}?overview=full&geometries=geojson&alternatives=3&steps=true`,
        {},
        12000
      );

      if (!response.ok) {
        throw new Error(`OSRM returned ${response.status}`);
      }

      const data = await response.json();

      if (data.code === "Ok" && Array.isArray(data.routes)) {
        data.routes.forEach((route: any) => {
          const coordinates: Point[] =
            (route.geometry?.coordinates || []).map(
              ([longitude, latitude]: [number, number]) => ({
                latitude,
                longitude,
              })
            );

          if (coordinates.length < 2) return;

          addCandidate({
            id: "",
            coordinates,
            distanceKm: Number(route.distance) / 1000,
            durationMin: Math.max(
              1,
              Math.round(Number(route.duration) / 60)
            ),
            safetyReady: false,
          });
        });
      }
    } catch (error) {
      console.warn("OSRM fallback failed:", error);
    }
  }

  // Prototype fallback: fill any missing slots with visibly offset
  // simulated paths. These are clearly flagged and are not real road routes.
  const simulatedOffsets = [220, -220, 420, -420, 650, -650];
  let simulatedIndex = 0;

  while (candidates.length < 3 && simulatedIndex < simulatedOffsets.length) {
    const simulated = makeSimulatedRoute(
      start,
      destination,
      simulatedOffsets[simulatedIndex],
      `demo-route-${candidates.length + 1}`
    );
    simulatedIndex += 1;

    if (
      !candidates.some((existing) =>
        !routesAreDifferent(existing.coordinates, simulated.coordinates)
      )
    ) {
      simulated.id = `demo-route-${candidates.length + 1}`;
      candidates.push(simulated);
    }
  }

  // Extremely short or identical coordinates can make offset paths overlap.
  // In that edge case, use larger visual offsets until three are available.
  while (candidates.length < 3) {
    const offset = 900 + candidates.length * 500;
    const simulated = makeSimulatedRoute(
      start,
      destination,
      offset,
      `demo-route-${candidates.length + 1}`
    );
    simulated.id = `demo-route-${candidates.length + 1}`;
    candidates.push(simulated);
  }

  candidates.sort((a, b) => a.durationMin - b.durationMin);
  return candidates.slice(0, 3).map((route, index) => ({
    ...route,
    id: route.isSimulated ? `demo-route-${index + 1}` : `route-${index + 1}`,
  }));
}

/* ============================================================
   DISTANCE CALCULATION
============================================================ */

function getDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) *
      Math.PI) /
    180;

  const dLon =
    ((lon2 - lon1) *
      Math.PI) /
    180;

  const a =
    Math.sin(
      dLat / 2
    ) **
      2 +
    Math.cos(
      (lat1 * Math.PI) /
        180
    ) *
      Math.cos(
        (lat2 * Math.PI) /
          180
      ) *
      Math.sin(
        dLon / 2
      ) **
        2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

/* ============================================================
   LIVE NAVIGATION HELPERS
============================================================ */

function getBearingDegrees(
  from: Point,
  to: Point
): number {
  const lat1 =
    (from.latitude * Math.PI) / 180;
  const lat2 =
    (to.latitude * Math.PI) / 180;
  const dLon =
    ((to.longitude - from.longitude) *
      Math.PI) /
    180;

  const y =
    Math.sin(dLon) *
    Math.cos(lat2);

  const x =
    Math.cos(lat1) *
      Math.sin(lat2) -
    Math.sin(lat1) *
      Math.cos(lat2) *
      Math.cos(dLon);

  return (
    (Math.atan2(y, x) * 180) /
      Math.PI +
    360
  ) % 360;
}

function getNearestRouteIndex(
  point: Point,
  coordinates: Point[]
): {
  index: number;
  distanceMeters: number;
} {
  if (!coordinates.length) {
    return {
      index: 0,
      distanceMeters: Infinity,
    };
  }

  let nearestIndex = 0;
  let nearestDistance =
    pointDistanceMeters(
      point,
      coordinates[0]
    );

  for (
    let index = 1;
    index < coordinates.length;
    index += 1
  ) {
    const distance =
      pointDistanceMeters(
        point,
        coordinates[index]
      );

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return {
    index: nearestIndex,
    distanceMeters: nearestDistance,
  };
}

function getRemainingRouteDistanceKm(
  point: Point,
  coordinates: Point[]
): number {
  if (coordinates.length < 2) {
    return 0;
  }

  const nearest =
    getNearestRouteIndex(
      point,
      coordinates
    );

  let remaining =
    pointDistanceMeters(
      point,
      coordinates[nearest.index]
    ) / 1000;

  for (
    let index = nearest.index;
    index < coordinates.length - 1;
    index += 1
  ) {
    remaining += getDistanceKm(
      coordinates[index].latitude,
      coordinates[index].longitude,
      coordinates[index + 1].latitude,
      coordinates[index + 1].longitude
    );
  }

  return remaining;
}

/* ============================================================
   NEARBY PLACES
============================================================ */

async function getNearbyPlaces(
  destination: GeoPoint
): Promise<NearbyPlace[]> {
  const radius = 5000;

  // First use the facilities JSON supplied with this project.
  // This keeps map markers available even when Overpass is unavailable.
  try {
    const localResponse = await fetchWithTimeout(
      `${API_BASE_URL}/facility-locations?lat=${destination.latitude}&lon=${destination.longitude}&radius=${radius}`,
      {},
      7000
    );

    if (localResponse.ok) {
      const localData = await localResponse.json();
      const localPlaces = Array.isArray(localData.locations)
        ? localData.locations
        : [];

      const validLocalPlaces = localPlaces
        .filter((place: any) =>
          place?.name &&
          Number.isFinite(Number(place.latitude)) &&
          Number.isFinite(Number(place.longitude))
        )
        .map((place: any) => ({
          name: String(place.name),
          type: String(place.type || place.category || "Facility"),
          distanceKm: Number(place.distanceKm) || 0,
          latitude: Number(place.latitude),
          longitude: Number(place.longitude),
        }))
        .sort((a: NearbyPlace, b: NearbyPlace) =>
          a.distanceKm - b.distanceKm
        );

      if (validLocalPlaces.length > 0) {
        return validLocalPlaces.slice(0, 25);
      }
    }
  } catch (error) {
    console.warn("Local facility API unavailable; trying OpenStreetMap:", error);
  }

  const around =
    `(around:${radius},${destination.latitude},${destination.longitude})`;

  const query = `
    [out:json][timeout:8];

    (
      nwr["amenity"="police"]${around};
      nwr["amenity"="hospital"]${around};
      nwr["amenity"="clinic"]${around};
      nwr["amenity"="cafe"]${around};
      nwr["amenity"="fuel"]${around};
      nwr["amenity"="pharmacy"]${around};
    );

    out center tags;
  `;

  try {
    const response =
      await fetchWithTimeout(
        "https://overpass-api.de/api/interpreter",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "text/plain",
          },

          body: query,
        },
        8000
      );

    if (!response.ok) {
      return [];
    }

    const data =
      await response.json();

    return (
      data.elements || []
    )
      .map(
        (item: any) => {
          const lat =
            item.lat ??
            item.center?.lat;

          const lon =
            item.lon ??
            item.center?.lon;

          if (
            lat == null ||
            lon == null
          ) {
            return null;
          }

          const amenity =
            item.tags?.amenity;

          const type =
            amenity === "police"
              ? "Police"
              : amenity ===
                "hospital"
              ? "Hospital"
              : amenity ===
                "clinic"
              ? "Clinic"
              : amenity ===
                "pharmacy"
              ? "Pharmacy"
              : amenity ===
                "fuel"
              ? "Fuel"
              : "Public place";

          return {
            name:
              item.tags?.name ||
              type,

            type,

            distanceKm:
              getDistanceKm(
                destination.latitude,
                destination.longitude,
                Number(lat),
                Number(lon)
              ),
            latitude: Number(lat),
            longitude: Number(lon),
          };
        }
      )
      .filter(Boolean)
      .sort(
        (
          a: NearbyPlace,
          b: NearbyPlace
        ) =>
          a.distanceKm -
          b.distanceKm
      )
      .slice(0, 25);
  } catch {
    return [];
  }
}

/* ============================================================
   FALLBACK NEARBY PLACES
============================================================ */

function getFallbackPlaces(): NearbyPlace[] {
  // Do not invent nearby facilities when live location data is unavailable.
  return [];
}

/* ============================================================
   MAP REGION
============================================================ */

function getRegion(
  start: Point,
  destination: Point
): Region {
  const minLat =
    Math.min(
      start.latitude,
      destination.latitude
    );

  const maxLat =
    Math.max(
      start.latitude,
      destination.latitude
    );

  const minLon =
    Math.min(
      start.longitude,
      destination.longitude
    );

  const maxLon =
    Math.max(
      start.longitude,
      destination.longitude
    );

  const latDelta =
    Math.max(
      (maxLat - minLat) *
        1.5,
      0.08
    );

  const lonDelta =
    Math.max(
      (maxLon - minLon) *
        1.5,
      0.08
    );

  return {
    latitude:
      (minLat + maxLat) /
      2,

    longitude:
      (minLon + maxLon) /
      2,

    latitudeDelta:
      Math.min(
        latDelta,
        120
      ),

    longitudeDelta:
      Math.min(
        lonDelta,
        120
      ),
  };
}

/* ============================================================
   FRONTEND SAFETY DATA
============================================================ */

/*
  Route scoring fallback uses the supplied project risk/historical datasets
  and mapped nearby facilities when the backend has no score for a route.
  It is an indicative mini-project estimate, not a verified safety prediction.
*/

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sampleRoutePoints(route: RouteData): Point[] {
  const count = Math.min(6, route.coordinates.length);
  return Array.from({ length: count }, (_, index) => {
    const position =
      count === 1
        ? 0
        : Math.round(
            (index / (count - 1)) * (route.coordinates.length - 1)
          );
    return route.coordinates[position];
  });
}

async function getRouteSafetyScores(
  routes: RouteData[]
): Promise<Array<{ riskScore?: number; safetyScore?: number; safetyDetails?: any }>> {
  if (!routes.length) return [];

  try {
    const response = await fetchWithTimeout(
      `${API_BASE_URL}/safety-data`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routes: routes.map(route => ({
            id: route.id,
            coordinates: route.coordinates,
          })),
        }),
      },
      11000
    );

    if (!response.ok) throw new Error(`Safety API returned ${response.status}`);
    const payload = await response.json();
    const results = Array.isArray(payload.results) ? payload.results : [];

    return routes.map(route => {
      const result = results.find((item: any) => String(item.id) === String(route.id));
      if (!result || !result.riskAssessmentAvailable || result.riskScore == null) {
        return { safetyDetails: result ?? { note: "Safety analysis unavailable." } };
      }
      return {
        riskScore: Number(result.riskScore),
        safetyScore: Number(result.safetyScore),
        safetyDetails: result,
      };
    });
  } catch (error) {
    console.warn("Backend route safety analysis failed:", error);
    return routes.map(() => ({
      safetyDetails: { note: "Backend safety analysis unavailable. Scores are not estimated." },
    }));
  }
}

async function getMapSafetyLocations(): Promise<{
  risks: RiskLocation[];
  historical: HistoricalLocation[];
}> {
  const [riskResult, historyResult] = await Promise.allSettled([
    fetchWithTimeout(`${API_BASE_URL}/risk-locations`, {}, 7000).then((r) => {
      if (!r.ok) throw new Error(`Risk locations API: ${r.status}`);
      return r.json();
    }),
    fetchWithTimeout(`${API_BASE_URL}/historical-locations`, {}, 7000).then((r) => {
      if (!r.ok) throw new Error(`Historical locations API: ${r.status}`);
      return r.json();
    }),
  ]);

  const validPoint = (item: any) =>
    Number.isFinite(Number(item?.latitude)) &&
    Number.isFinite(Number(item?.longitude));

  const risks =
    riskResult.status === "fulfilled" && Array.isArray(riskResult.value.locations)
      ? riskResult.value.locations.filter(validPoint)
      : [];
  const historical =
    historyResult.status === "fulfilled" && Array.isArray(historyResult.value.locations)
      ? historyResult.value.locations.filter(validPoint)
      : [];

  return { risks, historical };
}

function estimateRouteRiskFromProjectData(
  route: RouteData,
  risks: RiskLocation[],
  historical: HistoricalLocation[],
  facilities: NearbyPlace[]
): { riskScore: number; safetyScore: number; safetyDetails: any } {
  const samples = sampleRoutePoints(route);
  const nearRoute = (point: Point, radiusKm: number) =>
    samples.some((sample) =>
      getDistanceKm(sample.latitude, sample.longitude, point.latitude, point.longitude) <= radiusKm
    );

  const nearbyRisks = risks.filter((item) =>
    nearRoute({ latitude: Number(item.latitude), longitude: Number(item.longitude) }, 0.35)
  );
  const nearbyHistory = historical.filter((item) =>
    nearRoute({ latitude: Number(item.latitude), longitude: Number(item.longitude) }, 0.35)
  );
  const nearbyFacilities = facilities.filter((item) =>
    item.latitude != null &&
    item.longitude != null &&
    nearRoute({ latitude: item.latitude, longitude: item.longitude }, 0.5)
  );

  const riskWeight = nearbyRisks.reduce((sum, item) => {
    const level = String(item.risk_level || "").toLowerCase();
    return sum + (level.includes("high") ? 16 : level.includes("medium") ? 10 : 6);
  }, 0);
  const historyWeight = nearbyHistory.length * 9;
  const facilityCredit = Math.min(18, nearbyFacilities.length * 4);
  const riskScore = clamp(Math.round(24 + riskWeight + historyWeight - facilityCredit), 5, 95);

  return {
    riskScore,
    safetyScore: 100 - riskScore,
    safetyDetails: {
      source: "Project estimate using supplied risk/historical JSON and nearby mapped facilities",
      nearbyRiskLocationCount: nearbyRisks.length,
      nearbyHistoricalCount: nearbyHistory.length,
      nearbyFacilityCount: nearbyFacilities.length,
      note: "Indicative score based on mapped project data; not a verified safety guarantee.",
    },
  };
}

/* ============================================================
   HOME SCREEN
============================================================ */

export default function HomeScreen() {
  const [
    startLocation,
    setStartLocation,
  ] = useState("");

  const [
    useCurrentLocation,
    setUseCurrentLocation,
  ] = useState(false);

  const [
    currentStartPoint,
    setCurrentStartPoint,
  ] = useState<GeoPoint | null>(null);

  const [
    destination,
    setDestination,
  ] = useState(
    ""
  );

  const [
    showRoute,
    setShowRoute,
  ] = useState(false);

  const [
    locating,
    setLocating,
  ] = useState(false);

  const [
    activeTab,
    setActiveTab,
  ] = useState<AppTab>("Home");

  const [
    contacts,
    setContacts,
  ] = useState<EmergencyContact[]>([]);

  const [
    profile,
    setProfile,
  ] = useState<UserProfile>(
    DEFAULT_PROFILE
  );

  const [
    contactsLoaded,
    setContactsLoaded,
  ] = useState(false);

  const [
    profileLoaded,
    setProfileLoaded,
  ] = useState(false);

  const [
    showReport,
    setShowReport,
  ] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadSavedData = async () => {
      try {
        const [
          savedContacts,
          savedProfile,
        ] = await Promise.all([
          AsyncStorage.getItem(
            CONTACTS_STORAGE_KEY
          ),
          AsyncStorage.getItem(
            PROFILE_STORAGE_KEY
          ),
        ]);

        if (!mounted) return;

        if (savedContacts) {
          try {
            const parsed =
              JSON.parse(savedContacts);

            if (Array.isArray(parsed)) {
              setContacts(
                parsed.slice(0, 5)
              );
            }
          } catch {
            // Ignore malformed local data.
          }
        }

        if (savedProfile) {
          try {
            const parsed =
              JSON.parse(savedProfile);

            if (parsed && typeof parsed === "object") {
              setProfile({
                name:
                  typeof parsed.name === "string"
                    ? parsed.name
                    : "",
                phone:
                  typeof parsed.phone === "string"
                    ? parsed.phone
                    : "",
                email:
                  typeof parsed.email === "string"
                    ? parsed.email
                    : "",
              });
            }
          } catch {
            // Ignore malformed local data.
          }
        }
      } catch {
        // The app can still operate with in-memory data.
      } finally {
        if (mounted) {
          setContactsLoaded(true);
          setProfileLoaded(true);
        }
      }
    };

    loadSavedData();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!contactsLoaded) return;

    AsyncStorage.setItem(
      CONTACTS_STORAGE_KEY,
      JSON.stringify(contacts)
    ).catch(() => {});
  }, [contacts, contactsLoaded]);

  useEffect(() => {
    if (!profileLoaded) return;

    AsyncStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify(profile)
    ).catch(() => {});
  }, [profile, profileLoaded]);

  const handleUseCurrentLocation =
    async () => {
      try {
        setLocating(true);

        const {
          status,
        } =
          await Location.requestForegroundPermissionsAsync();

        if (status !== "granted") {
          Alert.alert(
            "Location permission needed",
            "Please allow Securia to access your location, or enter a starting point manually."
          );
          return;
        }

        const location =
          await Location.getCurrentPositionAsync({
            accuracy:
              Location.Accuracy.High,
          });

        const point: GeoPoint = {
          latitude:
            location.coords.latitude,
          longitude:
            location.coords.longitude,
          displayName:
            "Current location",
        };

        setCurrentStartPoint(point);
        setUseCurrentLocation(true);
        setStartLocation("");
      } catch {
        Alert.alert(
          "Unable to get location",
          "Securia could not get your current location. Please try again or enter a starting point manually."
        );
      } finally {
        setLocating(false);
      }
    };

  const handleManualStart =
    () => {
      setUseCurrentLocation(false);
      setCurrentStartPoint(null);
      setStartLocation("");
    };

  const handleFindRoute =
    () => {
      const hasStart =
        useCurrentLocation
          ? !!currentStartPoint
          : !!startLocation.trim();

      if (
        !hasStart ||
        !destination.trim()
      ) {
        Alert.alert(
          "Missing location",
          useCurrentLocation
            ? "Please make sure your current location is available and enter a destination."
            : "Please enter a starting point and destination."
        );

        return;
      }

      setShowRoute(true);
    };

  // Explore is a navigation action, not a route-generation shortcut.
  // It must only open route analysis when both locations are actually ready.
  const handleExplore = () => {
    const hasStart =
      useCurrentLocation
        ? !!currentStartPoint
        : !!startLocation.trim();

    if (!hasStart || !destination.trim()) {
      Alert.alert(
        "Enter locations first",
        useCurrentLocation
          ? "Please make sure your current location is available and enter a destination before opening Explore."
          : "Please enter a starting point and destination before opening Explore."
      );
      return;
    }

    setShowRoute(true);
  };

  const handleGlobalSOS = () => {
    setShowRoute(false);
    setShowReport(false);
    setActiveTab("SOS");
  };

  const handleGlobalProfile = () => {
    setShowRoute(false);
    setShowReport(false);
    setActiveTab("Profile");
  };

  const handleGlobalExplore = () => {
    const hasStart =
      useCurrentLocation
        ? !!currentStartPoint
        : !!startLocation.trim();

    if (!hasStart || !destination.trim()) {
      Alert.alert(
        "Enter locations first",
        useCurrentLocation
          ? "Please make sure your current location is available and enter a destination before opening Explore."
          : "Please enter a starting point and destination before opening Explore."
      );
      return;
    }

    setShowReport(false);
    setActiveTab("Explore");
    setShowRoute(true);
  };


  if (showRoute) {
    return (
      <RouteScreen
        contacts={contacts}
        startText={
          useCurrentLocation
            ? "Current location"
            : startLocation
        }
        startPoint={
          useCurrentLocation
            ? currentStartPoint
            : null
        }
        destinationText={
          destination
        }
        onBack={() => { setShowRoute(false); setActiveTab("Home"); }}
        onExplore={handleGlobalExplore}
        onSOS={handleGlobalSOS}
        onProfile={handleGlobalProfile}
      />
    );
  }

  if (showReport) {
    return (
      <ReportIncidentScreen
        onBack={() => setShowReport(false)}
        onExplore={handleGlobalExplore}
        onSOS={handleGlobalSOS}
        onProfile={handleGlobalProfile}
      />
    );
  }

  if (activeTab === "SOS") {
    return (
      <SOSEmergencyScreen
        contacts={contacts}
        onContactsChange={setContacts}
        profile={profile}
        onBackHome={() => setActiveTab("Home")}
        onExplore={handleGlobalExplore}
        onSOS={() => setActiveTab("SOS")}
        onProfile={handleGlobalProfile}
      />
    );
  }

  if (activeTab === "Profile") {
    return (
      <ProfileScreen
        profile={profile}
        onProfileChange={setProfile}
        contacts={contacts}
        onContactsChange={setContacts}
        onBackHome={() => setActiveTab("Home")}
        onExplore={handleGlobalExplore}
        onSOS={handleGlobalSOS}
        onProfile={() => setActiveTab("Profile")}
      />
    );
  }

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <KeyboardAvoidingView
        style={
          styles.container
        }
        behavior={
          Platform.OS ===
          "ios"
            ? "padding"
            : undefined
        }
      >
        <ScrollView
          contentContainerStyle={
            styles.homeScroll
          }
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={
            false
          }
        >
          {/* HEADER */}

          <View
            style={
              styles.header
            }
          >
            <View
              style={
                styles.headerText
              }
            >
              <Text
                style={
                  styles.logoText
                }
              >
                Securia
              </Text>

              <Text
                style={
                  styles.tagline
                }
              >
                Safer journeys.
                Smarter routes.
              </Text>
            </View>

            <View
              style={
                styles.logoCircle
              }
            >
              <Image
                source={
                  SECURIA_LOGO
                }
                style={
                  styles.logoImage
                }
                resizeMode="contain"
              />
            </View>
          </View>

          {/* MAIN CARD */}

          <View
            style={
              styles.mainCard
            }
          >
            <Text
              style={
                styles.heading
              }
            >
              Where are you{"\n"}
              going?
            </Text>

            <Text
              style={
                styles.description
              }
            >
              Find a safer route
              to your destination.
            </Text>

            {/* STARTING LOCATION CHOICES */}

            <Text
              style={
                styles.startLocationLabel
              }
            >
              Starting Location
            </Text>

            <Pressable
              style={({ pressed }) => [
                styles.currentLocationButton,
                useCurrentLocation &&
                  styles.currentLocationButtonActive,
                pressed &&
                  styles.pressed,
              ]}
              onPress={
                handleUseCurrentLocation
              }
              disabled={locating}
            >
              <Text
                style={
                  styles.currentLocationIcon
                }
              >
                📍
              </Text>

              <View
                style={
                  styles.currentLocationTextWrap
                }
              >
                <Text
                  style={
                    styles.currentLocationTitle
                  }
                >
                  {locating
                    ? "Getting your location…"
                    : useCurrentLocation
                    ? "Current location selected"
                    : "Use my current location"}
                </Text>

                <Text
                  style={
                    styles.currentLocationSubtitle
                  }
                >
                  {useCurrentLocation
                    ? "Using your phone's GPS"
                    : "Use GPS instead of entering a place name"}
                </Text>
              </View>

              <Text
                style={
                  styles.currentLocationCheck
                }
              >
                {useCurrentLocation
                  ? "✓"
                  : "›"}
              </Text>
            </Pressable>

            <View
              style={
                styles.orDividerRow
              }
            >
              <View
                style={
                  styles.orLine
                }
              />

              <Text
                style={
                  styles.orText
                }
              >
                OR
              </Text>

              <View
                style={
                  styles.orLine
                }
              />
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.manualLocationButton,
                !useCurrentLocation &&
                  startLocation.trim() &&
                  styles.manualLocationButtonActive,
                pressed &&
                  styles.pressed,
              ]}
              onPress={
                handleManualStart
              }
            >
              <Text
                style={
                  styles.manualLocationIcon
                }
              >
                ✏️
              </Text>

              <Text
                style={
                  styles.manualLocationText
                }
              >
                Enter a starting point manually
              </Text>
            </Pressable>

            {!useCurrentLocation && (
              <View
                style={
                  styles.inputBox
                }
              >
                <Text
                  style={
                    styles.pin
                  }
                >
                  📍
                </Text>

                <View
                  style={
                    styles.divider
                  }
                />

                <TextInput
                  style={
                    styles.input
                  }
                  placeholder="Enter starting point"
                  placeholderTextColor={
                    COLORS.creamText
                  }
                  value={
                    startLocation
                  }
                  onChangeText={(text) => {
                    setStartLocation(
                      text
                    );
                    setUseCurrentLocation(
                      false
                    );
                    setCurrentStartPoint(
                      null
                    );
                  }}
                  returnKeyType="next"
                />
              </View>
            )}

            {useCurrentLocation && (
              <View
                style={
                  styles.selectedLocationBox
                }
              >
                <Text
                  style={
                    styles.selectedLocationIcon
                  }
                >
                  ✓
                </Text>

                <View
                  style={
                    styles.selectedLocationTextWrap
                  }
                >
                  <Text
                    style={
                      styles.selectedLocationTitle
                    }
                  >
                    Current location
                  </Text>

                  <Text
                    style={
                      styles.selectedLocationSubtitle
                    }
                  >
                    GPS coordinates will be used as your starting point
                  </Text>
                </View>
              </View>
            )}

            {/* DESTINATION */}

            <View
              style={
                styles.inputBox
              }
            >
              <Text
                style={
                  styles.pin
                }
              >
                📍
              </Text>

              <View
                style={
                  styles.divider
                }
              />

              <TextInput
                style={
                  styles.input
                }
                placeholder="Enter destination"
                placeholderTextColor={
                  COLORS.creamText
                }
                value={
                  destination
                }
                onChangeText={
                  setDestination
                }
                returnKeyType="done"
              />
            </View>

                        {/* ROUTE */}

            <Pressable
              style={({ pressed }) => [
                styles.routeButton,
                pressed &&
                  styles.routePressed,
              ]}
              onPress={
                handleFindRoute
              }
            >
              <Text
                style={
                  styles.routeButtonText
                }
              >
                Find Safer Route
              </Text>

              <Text
                style={
                  styles.arrow
                }
              >
                →
              </Text>
            </Pressable>
          </View>

          {/* QUICK ACCESS */}

          <View
            style={
              styles.quickAccess
            }
          >
            <Text
              style={
                styles.sectionTitle
              }
            >
              Quick Access
            </Text>

            <View
              style={
                styles.quickRow
              }
            >
              <QuickButton
                icon="☎"
                label="Emergency"
                onPress={() =>
                  setActiveTab("SOS")
                }
              />

              <QuickButton
                icon="🛡"
                label="Share Live"
                onPress={() =>
                  setActiveTab("SOS")
                }
              />

              <QuickButton
                icon="👥"
                label="Trusted"
                onPress={() =>
                  setActiveTab("Profile")
                }
              />

              <QuickButton
                icon="⚠"
                label="Report"
                onPress={() =>
                  setShowReport(true)
                }
              />
            </View>
          </View>
        </ScrollView>

        <BottomNav
          active="Home"
          onHome={() => setActiveTab("Home")}
          onExplore={handleExplore}
          onSOS={handleGlobalSOS}
          onProfile={handleGlobalProfile}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ============================================================
   QUICK BUTTON
============================================================ */

function QuickButton({
  icon,
  label,
  onPress,
}: {
  icon: string;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={
        styles.quickButton
      }
      onPress={
        onPress ||
        (() =>
          Alert.alert(
            label,
            "This feature will be connected in the next integration step."
          ))
      }
    >
      <Text
        style={
          styles.quickIcon
        }
      >
        {icon}
      </Text>

      <Text
        style={
          styles.quickText
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ============================================================
   ROUTE SCREEN
============================================================ */

function RouteScreen({
  contacts,
  startText,
  startPoint: providedStartPoint,
  destinationText,
  onBack,
  onExplore,
  onSOS,
  onProfile,
}: {
  contacts: EmergencyContact[];
  startText: string;
  startPoint?: GeoPoint | null;
  destinationText: string;
  onBack: () => void;
  onExplore: () => void;
  onSOS: () => void;
  onProfile: () => void;
}) {
  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  const [
    start,
    setStart,
  ] = useState<GeoPoint | null>(
    null
  );

  const [
    destination,
    setDestination,
  ] = useState<GeoPoint | null>(
    null
  );

  const [
    routes,
    setRoutes,
  ] = useState<RouteData[]>(
    []
  );

  const [
    nearbyPlaces,
    setNearbyPlaces,
  ] = useState<
    NearbyPlace[]
  >([]);

  const [exploreDetailPage, setExploreDetailPage] =
    useState<"places" | "laws" | null>(null);

  const [riskLocations, setRiskLocations] = useState<RiskLocation[]>([]);
  const [historicalLocations, setHistoricalLocations] = useState<HistoricalLocation[]>([]);
  const [facilityNavigationName, setFacilityNavigationName] = useState<string | null>(null);  
  useEffect(() => {
    let active = true;
    getMapSafetyLocations()
      .then(({ risks, historical }) => {
        if (!active) return;
        setRiskLocations(risks);
        setHistoricalLocations(historical);
      })
      .catch((error) => console.warn("Could not load map safety locations:", error));
    return () => {
      active = false;
    };
  }, []);

  const [
    selectedRoute,
    setSelectedRoute,
  ] = useState<RouteKind>(
    "safer"
  );

  const [
    showNavigation,
    setShowNavigation,
  ] = useState(false);

  const mapRef =
    useRef<MapView | null>(
      null
    );

  const routeSessionKey = [
    startText.trim().toLowerCase(),
    destinationText.trim().toLowerCase(),
    providedStartPoint
      ? providedStartPoint.latitude.toFixed(6)
      : "",
    providedStartPoint
      ? providedStartPoint.longitude.toFixed(6)
      : "",
  ].join("|");

  /* ==========================================================
     LOAD ROUTE
  ========================================================== */

  useEffect(() => {
    let cancelled = false;

    // If this exact journey was already generated, restore it instead of
    // calling geocoding/routing/Overpass again. This makes Explore persistent
    // when the user jumps between taskbar tabs.
    if (
      routeSessionCache &&
      routeSessionCache.key === routeSessionKey
    ) {
      setStart(routeSessionCache.start);
      setDestination(routeSessionCache.destination);
      setRoutes(routeSessionCache.routes);
      setNearbyPlaces(routeSessionCache.nearbyPlaces);
      setSelectedRoute(routeSessionCache.selectedRoute);
      setError("");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function loadRoute() {
      try {
        setLoading(true);
        setError("");

        const destinationPoint =
          await geocode(
            destinationText
          );

        const startPoint =
          providedStartPoint ||
          await geocode(
            startText
          );

        if (
          !startPoint ||
          !destinationPoint
        ) {
          throw new Error(
            "One or both locations could not be found. Try a more specific place name."
          );
        }

        const routeResults =
          await getRoutes(
            startPoint,
            destinationPoint
          );

        const safetyResults = await getRouteSafetyScores(routeResults);
        const mapData = await getMapSafetyLocations();

        let places =
          await getNearbyPlaces(
            destinationPoint
          );

        /*
          If Overpass doesn't respond,
          use safe prototype fallback
          cards instead of showing a
          broken empty section.
        */

        if (
          !places.length
        ) {
          places =
            getFallbackPlaces();
        }

        const routesWithSafety = routeResults.map((route, index) => {
          const projectEstimate = estimateRouteRiskFromProjectData(
            route,
            mapData.risks,
            mapData.historical,
            places
          );
          const backendScore = safetyResults[index]?.riskScore;
          return {
            ...route,
            riskScore: backendScore != null ? backendScore : projectEstimate.riskScore,
            safetyScore:
              safetyResults[index]?.safetyScore != null
                ? safetyResults[index].safetyScore
                : projectEstimate.safetyScore,
            safetyReady: true,
            safetyDetails: {
              ...(projectEstimate.safetyDetails || {}),
              ...(safetyResults[index]?.safetyDetails || {}),
              scoreSource:
                backendScore != null
                  ? "Backend route safety analysis"
                  : "Project estimate from supplied map datasets",
            },
          };
        });

        if (cancelled) {
          return;
        }

        setStart(
          startPoint
        );

        setDestination(
          destinationPoint
        );

        setRoutes(
          routesWithSafety
        );

        setNearbyPlaces(
          places
        );
        setRiskLocations(mapData.risks);
        setHistoricalLocations(mapData.historical);

        setSelectedRoute(
          "safer"
        );

        routeSessionCache = {
          key: routeSessionKey,
          start: startPoint,
          destination: destinationPoint,
          routes: routesWithSafety,
          nearbyPlaces: places,
          selectedRoute: "safer",
        };
      } catch (err: any) {
        if (!cancelled) {
          setError(
            err?.message ||
              "Unable to load the route. Please check your internet connection."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadRoute();

    return () => {
      cancelled = true;
    };
  }, [
    startText,
    destinationText,
    providedStartPoint?.latitude,
    providedStartPoint?.longitude,
  ]);

const handleFacilityNavigate = async (place: NearbyPlace) => {
  try {
    setLoading(true);
    setError("");

    const { status } =
      await Location.requestForegroundPermissionsAsync();

    if (status !== "granted") {
      Alert.alert(
        "Location permission needed",
        "Please allow Securia to access your current location."
      );
      return;
    }

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const startPoint: GeoPoint = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      displayName: "Current location",
    };

    const destinationPoint: GeoPoint = {
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
      displayName: place.name,
    };

    let facilityRoutes: RouteData[];

    try {
      facilityRoutes = await getRoutes(
        startPoint,
        destinationPoint
      );
    } catch {
      // Illustrative fallback routes for the prototype.
      const distance = getDistanceKm(
        startPoint.latitude,
        startPoint.longitude,
        destinationPoint.latitude,
        destinationPoint.longitude
      );

      facilityRoutes = [0, 1, 2].map((index) => ({
        id: `demo-route-${index + 1}`,
        coordinates: [startPoint, destinationPoint],
        distanceKm: distance * (1 + index * 0.08),
        durationMin: Math.max(1, Math.round(distance * 3 * (1 + index * 0.08))),
        riskScore: 20 + index * 10,
        safetyScore: 80 - index * 10,
        safetyReady: true,
        safetyDetails: {
          note: "Illustrative route.",
        },
      }));
    }

    const safetyResults =
      await getRouteSafetyScores(facilityRoutes);

    const routesWithSafety = facilityRoutes.map((route, index) => ({
      ...route,
      riskScore: safetyResults[index]?.riskScore ?? route.riskScore ?? 30,
      safetyScore: safetyResults[index]?.safetyScore ?? route.safetyScore ?? 70,
      safetyReady: true,
      safetyDetails: safetyResults[index]?.safetyDetails ?? route.safetyDetails,
    }));

    setStart(startPoint);
    setDestination(destinationPoint);
    setRoutes(routesWithSafety);
    setSelectedRoute("safer");
    setFacilityNavigationName(place.name);
    setShowNavigation(true);

  } catch (error: any) {
    Alert.alert(
      "Navigation error",
      error?.message || "Unable to get your current location."
    );
  } finally {
    setLoading(false);
  }
};

  /* ==========================================================
     MAP FIT
  ========================================================== */


useEffect(() => {
  if (!start || !destination || !routes.length) {
    return;
  }

  const validMarkerPoints = [
    ...riskLocations,
    ...historicalLocations,
    ...nearbyPlaces,
  ]
    .map((place) => ({
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
    }))
    .filter(
      (point) =>
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        Math.abs(point.latitude) <= 90 &&
        Math.abs(point.longitude) <= 180
    );

  const allCoordinates = [
    start,
    destination,
    ...routes.flatMap((route) => route.coordinates),
    ...validMarkerPoints,
  ];

  const timer = setTimeout(() => {
    mapRef.current?.fitToCoordinates(allCoordinates, {
      edgePadding: {
        top: 80,
        right: 45,
        bottom: 80,
        left: 45,
      },
      animated: true,
    });
  }, 500);

  return () => clearTimeout(timer);
}, [
  start,
  destination,
  routes,
  riskLocations,
  historicalLocations,
  nearbyPlaces,
]);


  /* ==========================================================
     ROUTE INFO
  ========================================================== */

 
const routeInfo = useMemo(() => {
  if (routes.length < 3) return null;

  // Fastest route is selected by travel time.
  const fastest = [...routes].sort(
    (a, b) => a.durationMin - b.durationMin
  )[0];

  // Find the lowest-risk route among the remaining alternatives.
  const remainingRoutes = routes.filter(
    (route) => route.id !== fastest.id
  );

  const safest = [...remainingRoutes].sort(
    (a, b) =>
      (a.riskScore ?? 100) - (b.riskScore ?? 100)
  )[0];

  // Find the highest-risk route among the last remaining alternatives.
  const finalRoutes = remainingRoutes.filter(
    (route) => route.id !== safest.id
  );

  const risky = [...finalRoutes].sort(
    (a, b) =>
      (b.riskScore ?? -1) - (a.riskScore ?? -1)
  )[0];

  return {
    fastest,
    safest,
    risky,
  };
}, [routes]);


  const getRiskScoreForRoute =
    (route: RouteData): number | null =>
      route.riskScore == null
        ? null
        : Math.round(route.riskScore);

  const overallSafetyScore =
    routeInfo?.safest.safetyScore ?? null;

  /* ==========================================================
     REGION
  ========================================================== */

  const region =
    start && destination
      ? getRegion(
          start,
          destination
        )
      : undefined;

  /* ==========================================================
     NAVIGATION SCREEN
  ========================================================== */

  if (
    showNavigation &&
    start &&
    destination &&
    routeInfo
  ) {
    const navigationRoute =
      selectedRoute === "safer"
        ? routeInfo.safest
        : selectedRoute === "fastest"
        ? routeInfo.fastest
        : routeInfo.risky;

    return (
      <NavigationScreen
        start={start}
        destination={destination}
        route={navigationRoute}
        startText={facilityNavigationName ? "Current location" : startText}
        destinationText={facilityNavigationName ?? destinationText}
        routeKind={selectedRoute}
        onBack={() => {
  setShowNavigation(false);
  setFacilityNavigationName(null);
}}
        onExplore={onExplore}
        onSOS={onSOS}
        contacts={contacts}
        onProfile={onProfile}
      />
    );
  }

  /* ==========================================================
     EXPLORE DETAIL PAGES: SAFE PLACES / LAWS & HELPLINES
  ========================================================== */

  if (exploreDetailPage) {
    const isPlacesPage = exploreDetailPage === "places";
    const pageTitle = isPlacesPage ? "Nearby Safe Places" : "Laws & Helplines";

    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.routeContainer}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14 }}>
            <Pressable onPress={() => setExploreDetailPage(null)} style={styles.backButton}>
              <Text style={styles.backArrow}>‹</Text>
            </Pressable>
            <Text style={{ color: COLORS.gold, fontSize: 22, fontWeight: "800", marginLeft: 12, flex: 1 }}>
              {pageTitle}
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 36 }}>
            {isPlacesPage ? (
              <>
                <Text style={{ color: COLORS.cream, opacity: 0.75, fontSize: 13, marginBottom: 14 }}>
                  Places found within approximately 5 km of your destination. Tap a place to navigate to it using Securia.
                </Text>
                {nearbyPlaces.length > 0 ? nearbyPlaces.slice(0, 25).map((place, index) => {
                  const placeQuery = encodeURIComponent(`${place.name}, ${place.type}`);
                  const mapUrl = Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude))
                    ? `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`
                    : `https://www.google.com/maps/search/?api=1&query=${placeQuery}`;
                  const icon = place.type === "Police" ? "🛡" : place.type === "Hospital" || place.type === "Clinic" ? "🏥" : place.type === "Pharmacy" ? "💊" : place.type === "Fuel" ? "⛽" : "☕";
                  return (
                    <Pressable key={`${place.name}-${index}`} onPress={() => handleFacilityNavigate(place)} style={{ flexDirection: "row", alignItems: "center", backgroundColor: COLORS.card, borderColor: COLORS.cardBorder, borderWidth: 1, borderRadius: 15, padding: 15, marginBottom: 11 }}>
                      <Text style={{ fontSize: 27, width: 43 }}>{icon}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: COLORS.cream, fontSize: 15, fontWeight: "700" }}>{place.name}</Text>
                        <Text style={{ color: COLORS.goldLight, fontSize: 12, marginTop: 4 }}>{place.type} • {place.distanceKm.toFixed(1)} km away</Text>
                      </View>
                      <Text style={{ color: COLORS.gold, fontSize: 22 }}>›</Text>
                    </Pressable>
                  );
                }) : (
                  <View style={{ backgroundColor: COLORS.card, borderColor: COLORS.cardBorder, borderWidth: 1, borderRadius: 15, padding: 18 }}>
                    <Text style={{ color: COLORS.cream, fontSize: 14, lineHeight: 21 }}>No nearby places could be loaded right now. Please check your internet connection and try generating the route again.</Text>
                  </View>
                )}
                {nearbyPlaces.length > 0 && nearbyPlaces.length < 6 && (
                  <Text style={{ color: COLORS.cream, opacity: 0.65, fontSize: 12, lineHeight: 18, marginTop: 5 }}>
                    Only {nearbyPlaces.length} matching places were returned by the map data source for this area. The app does not add made-up locations.
                  </Text>
                )}
              </>
            ) : (
              <>
                <Text style={{ color: COLORS.cream, opacity: 0.75, fontSize: 13, marginBottom: 14, lineHeight: 19 }}>
                  General information about selected offences under the Bharatiya Nyaya Sanhita (BNS). The applicable punishment depends on the facts and legal process.
                </Text>
                <SafetyLaws />
                <Text style={{ color: COLORS.gold, fontSize: 18, fontWeight: "800", marginTop: 22, marginBottom: 12 }}>Important Helplines</Text>
                {[
                  { number: "112", name: "Emergency Response", info: "Police, fire and medical emergencies" },
                  { number: "181", name: "Women Helpline", info: "Support and assistance for women" },
                  { number: "1091", name: "Women in Distress", info: "Women’s police helpline" },
                ].map((item) => (
                  <Pressable key={item.number} onPress={() => Linking.openURL(`tel:${item.number}`)} style={{ backgroundColor: COLORS.card, borderColor: COLORS.cardBorder, borderWidth: 1, borderRadius: 15, padding: 15, marginBottom: 10, flexDirection: "row", alignItems: "center" }}>
                    <Text style={{ color: COLORS.gold, fontSize: 23, fontWeight: "800", width: 65 }}>{item.number}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: COLORS.cream, fontSize: 14, fontWeight: "700" }}>{item.name}</Text>
                      <Text style={{ color: COLORS.cream, opacity: 0.7, fontSize: 11, marginTop: 3 }}>{item.info}</Text>
                    </View>
                    <Text style={{ color: COLORS.gold, fontSize: 21 }}>☎</Text>
                  </Pressable>
                ))}
                <Text style={{ color: COLORS.cream, opacity: 0.6, fontSize: 11, lineHeight: 17, marginTop: 8 }}>For immediate danger, call 112. This page is for general awareness and is not legal advice. Verify current laws and helpline availability with official sources.</Text>
              </>
            )}
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  }

  /* ==========================================================
     RENDER
  ========================================================== */

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <View
        style={
          styles.routeContainer
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.routeScroll
          }
        >
          {/* ==================================================
              HEADER
          ================================================== */}

          <View
            style={
              styles.routeHeader
            }
          >
            <Pressable
              onPress={onBack}
              style={
                styles.backButton
              }
            >
              <Text
                style={
                  styles.backArrow
                }
              >
                ‹
              </Text>
            </Pressable>

            <View
              style={
                styles.routeHeaderText
              }
            >
              <Text
                style={
                  styles.routeTo
                }
              >
                Route to
              </Text>

              <Text
                style={
                  styles.routeDestination
                }
                numberOfLines={
                  1
                }
              >
                {destinationText}
              </Text>
            </View>

            <Text
              style={
                styles.menuDots
              }
            >
              ⋮
            </Text>
          </View>

          {/* ==================================================
              MAP
          ================================================== */}

          <View
            style={
              styles.mapCard
            }
          >
            {loading ? (
              <View
                style={
                  styles.mapLoading
                }
              >
                <ActivityIndicator
                  size="large"
                  color={
                    COLORS.gold
                  }
                />

                <Text
                  style={
                    styles.mapLoadingTitle
                  }
                >
                  Finding safer
                  routes…
                </Text>

                <Text
                  style={
                    styles.mapLoadingText
                  }
                >
                  Checking roads and
                  route alternatives.
                </Text>
              </View>
            ) : error ? (
              <View
                style={
                  styles.mapLoading
                }
              >
                <Text
                  style={
                    styles.errorIcon
                  }
                >
                  ⚠
                </Text>

                <Text
                  style={
                    styles.mapLoadingTitle
                  }
                >
                  Route unavailable
                </Text>

                <Text
                  style={
                    styles.mapLoadingText
                  }
                >
                  {error}
                </Text>

                <Pressable
                  style={
                    styles.retryButton
                  }
                  onPress={
                    onBack
                  }
                >
                  <Text
                    style={
                      styles.retryText
                    }
                  >
                    Change locations
                  </Text>
                </Pressable>
              </View>
            ) : (
              <MapView
                ref={mapRef}
                style={styles.map}
                initialRegion={
                  region
                }
                showsUserLocation={
                  false
                }
                showsMyLocationButton={
                  false
                }
                showsCompass={
                  false
                }
              >
                {/* ROUTES */}

                {routes.map(
                  (
                    route,
                    index
                  ) => {
                    const isSafest =
                      route ===
                      routeInfo?.safest;

                    const isFastest =
                      route ===
                      routeInfo?.fastest;

                    const isRiskier =
                      route ===
                      routeInfo?.risky;

                    const isSelected =
                      (selectedRoute ===
                        "safer" &&
                        isSafest) ||
                      (selectedRoute ===
                        "fastest" &&
                        isFastest) ||
                      (selectedRoute ===
                        "riskier" &&
                        isRiskier);

                    let routeColor =
                      "#6E6467";

                    if (
                      isSelected
                    ) {
                      if (
                        selectedRoute ===
                        "safer"
                      ) {
                        routeColor =
                          COLORS.green;
                      } else if (
                        selectedRoute ===
                        "fastest"
                      ) {
                        routeColor =
                          COLORS.pink;
                      } else {
                        routeColor =
                          COLORS.red;
                      }
                    }

                    return (
                      <Polyline
                        key={`route-${index}`}
                        coordinates={
                          route.coordinates
                        }
                        strokeWidth={
                          isSelected
                            ? 7
                            : 3
                        }
                        strokeColor={
                          routeColor
                        }
                        lineCap="round"
                        lineJoin="round"
                      />
                    );
                  }
                )}

                {/* RISK LOCATIONS - red markers */}
{riskLocations.map((place) => (
  <Marker
    key={`risk-${place.id}`}
    coordinate={{
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
    }}
    pinColor="#E53935"
  >
    <Callout tooltip={false}>
      <View style={{
        backgroundColor: "white",
        padding: 12,
        borderRadius: 12,
        width: 220,
      }}>
        <Text style={{ fontWeight: "bold", color: "#E53935", fontSize: 15 }}>
          ⚠ Risk Location
        </Text>
        <Text style={{ fontWeight: "bold", marginTop: 6 }}>
          {place.location_name || place.name || "Risk location"}
        </Text>
        <Text style={{ marginTop: 4, color: "#555" }}>
          {place.reason || place.category || "Project risk dataset"}
        </Text>
      </View>
    </Callout>
  </Marker>
))}
{/* HISTORICAL REPORT LOCATIONS - amber markers */}
{historicalLocations.map((place) => (
  <Marker
    key={`history-${place.id}`}
    coordinate={{
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
    }}
    pinColor="#D97706"
  >
    <Callout tooltip={false}>
      <View style={{
        backgroundColor: "white",
        padding: 12,
        borderRadius: 12,
        width: 220,
      }}>
        <Text style={{ fontWeight: "bold", color: "#D97706", fontSize: 15 }}>
          Historical Report
        </Text>
        <Text style={{ fontWeight: "bold", marginTop: 6 }}>
          {place.name || "Historical reported location"}
        </Text>
        <Text style={{ marginTop: 4, color: "#555" }}>
          {place.reason || "Historical project dataset"}
        </Text>
      </View>
    </Callout>
  </Marker>
))}
{/* NEARBY FACILITIES - green/blue markers */}
{nearbyPlaces
  .filter((place) =>
    Number.isFinite(Number(place.latitude)) &&
    Number.isFinite(Number(place.longitude))
  )
  .map((place, index) => (
    <Marker
      key={`facility-${place.name}-${index}`}
      coordinate={{
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
      }}
      pinColor={
        place.type === "Police"
          ? "#2563EB"
          : place.type === "Hospital" || place.type === "Clinic"
          ? "#16A34A"
          : "#0D9488"
      }
    >
      
<Callout tooltip={false}>
  <View style={{
    backgroundColor: "white",
    padding: 12,
    borderRadius: 12,
    width: 220,
  }}>
    <Text style={{ fontWeight: "bold", fontSize: 15 }}>
      {place.name}
    </Text>

    <Text style={{ color: "#555", marginTop: 4 }}>
      {place.type}
    </Text>

    <CalloutSubview
      onPress={() => handleFacilityNavigate(place)}
    >
      <View style={{
        backgroundColor: "#2563EB",
        padding: 10,
        borderRadius: 8,
        marginTop: 75,
        alignItems: "center",
      }}>
        <Text style={{ color: "white", fontWeight: "bold" }}>
          ➤ Navigate to this place
        </Text>
      </View>
    </CalloutSubview>
  </View>
</Callout>
</Marker>
  ))}

                {/* START */}

                {start && (
                  <Marker
                    coordinate={
                      start
                    }
                    title={
                      startText
                    }
                  >
                    <View
                      style={
                        styles.startMarker
                      }
                    >
                      <View
                        style={
                          styles.markerDot
                        }
                      />
                    </View>
                  </Marker>
                )}

                {/* DESTINATION */}

                {destination && (
                  <Marker
                    coordinate={
                      destination
                    }
                    title={
                      destinationText
                    }
                  >
                    <View
                      style={
                        styles.destinationMarker
                      }
                    >
                      <Text
                        style={
                          styles.destinationMarkerText
                        }
                      >
                        ●
                      </Text>
                    </View>
                  </Marker>
                )}
              </MapView>
            )}
          </View>

          {/* ==================================================
              ROUTE OPTIONS
          ================================================== */}

          {!loading &&
            !error &&
            routeInfo && (
              <>
                <View
                  style={
                    styles.routeOptionsHeader
                  }
                >
                  <Text
                    style={
                      styles.sectionTitle
                    }
                  >
                    Route Options
                  </Text>

                  <Text
                    style={
                      styles.sortText
                    }
                  >
                    Sort by{" "}
                    <Text
                      style={
                        styles.sortHighlight
                      }
                    >
                      Safety
                    </Text>
                  </Text>
                </View>

                <Text style={styles.safetyDataNote}>
                  Route estimates use the project's Bengaluru risk and historical-location datasets plus mapped nearby facilities. Scores are indicative estimates, not verified safety guarantees.
                </Text>

                {/* SAFER */}

                <RouteOption
                  title="Safer Route"
                  badge="Recommended"
                  route={
                    routeInfo.safest
                  }
                  icon="🛡"
                  color={
                    COLORS.green
                  }
                  description={
                    routeInfo.safest.isSimulated
                      ? "SIMULATED PROTOTYPE PATH — not a verified road route"
                      : "Selected from a distinct alternative using available OSM safety indicators"
                  }
                  riskScore={
                    getRiskScoreForRoute(
                      routeInfo.safest
                    )
                  }
                  onPress={() =>
                    setSelectedRoute(
                      "safer"
                    )
                  }
                />

                {/* FASTEST */}

                <RouteOption
                  title="Fastest Route"
                  route={
                    routeInfo.fastest
                  }
                  icon="👥"
                  color={
                    COLORS.pink
                  }
                  description={
                    routeInfo.fastest.isSimulated
                      ? "Estimated quickest option based on route distance and travel time calculation"
                      : "Shortest travel-time alternative; safety is evaluated separately"
                  }
                  riskScore={
                    getRiskScoreForRoute(
                      routeInfo.fastest
                    )
                  }
                  onPress={() =>
                    setSelectedRoute(
                      "fastest"
                    )
                  }
                />

                {/* RISKY */}

                <RouteOption
                  title="Risky Route"
                  route={
                    routeInfo.risky
                  }
                  icon="⚠"
                  color={
                    COLORS.red
                  }
                  description={
                    routeInfo.risky.isSimulated
                      ? "SIMULATED PROTOTYPE PATH — not a verified road route"
                      : "Distinct alternative with the highest available route risk score"
                  }
                  danger
                  riskScore={
                    getRiskScoreForRoute(
                      routeInfo.risky
                    )
                  }
                  onPress={() =>
                    setSelectedRoute(
                      "riskier"
                    )
                  }
                />

                {/* ==================================================
                    SAFETY INSIGHTS
                ================================================== */}

                <Text
                  style={
                    styles.sectionTitle
                  }
                >
                  Safety Insights
                </Text>

                <View
                  style={
                    styles.insightRow
                  }
                >
                  <Insight
                    icon="⚠"
                    value="Less"
                    label="Risk markers near route"
                  />

                  <Insight
                    icon="🏥"
                    value="High"
                    label="Nearby facilities"
                  />

                  <Insight
                    icon="🛡"
                    value={
                      routeInfo.safest.riskScore == null
                        ? "N/A"
                        : `${Math.round(100 - routeInfo.safest.riskScore)}/100`
                    }
                    label="Estimated safety score"
                  />
                </View>

                {/* ==================================================
                    NEARBY SAFE PLACES
                ================================================== */}

                <View
                  style={
                    styles.safePlacesHeader
                  }
                >
                  <Text
                    style={
                      styles.sectionTitleNoMargin
                    }
                  >
                    Nearby Safe Places
                  </Text>

                  <Pressable onPress={() => setExploreDetailPage("places")} hitSlop={10}>
                    <Text style={styles.seeAll}>See all →</Text>
                  </Pressable>
                </View>

                <View
                  style={
                    styles.placesRow
                  }
                >
                  {nearbyPlaces.slice(0, 4).map(
                    (
                      place,
                      index
                    ) => (
                      <NearbyCard
                        key={`${place.name}-${index}`}
                        place={
                          place
                        }
                      />
                    )
                  )}
                </View>

                {/* ==================================================
                    LAWS & HELPLINES
                ================================================== */}

                <View
                  style={
                    styles.lawsHeader
                  }
                >
                  <Text
                    style={
                      styles.sectionTitleNoMargin
                    }
                  >
                    Laws & Helplines
                  </Text>

                  <Pressable onPress={() => setExploreDetailPage("laws")} hitSlop={10}>
                    <Text style={styles.seeAll}>See all →</Text>
                  </Pressable>
                </View>

                <SafetyLaws />

                <View
                  style={
                    styles.helplineRow
                  }
                >
                  <HelplineCard
                    icon="☎"
                    value="112"
                    label="Emergency"
                    sublabel="Police / Medical / Fire"
                  />

                  <HelplineCard
                    icon="♀"
                    value="181"
                    label="Women Helpline"
                    sublabel="Women support"
                  />

                  <HelplineCard
                    icon="👮"
                    value="1091"
                    label="Women in Distress"
                    sublabel="Police"
                  />
                </View>

                {/* ==================================================
                    RISKIER ROUTE ANALYSIS
                ================================================== */}

                <View
                  style={
                    styles.riskAnalysisHeader
                  }
                >
                  <Text
                    style={
                      styles.sectionTitleNoMargin
                    }
                  >
                    ⚠ Riskier Route
                    Analysis
                  </Text>

                  <Text
                    style={
                      styles.seeAll
                    }
                  >
                    View Details →
                  </Text>
                </View>

                <View
                  style={
                    styles.analysisRow
                  }
                >
                  <AnalysisCard
                    icon="⚑"
                    title="Route length"
                    value={`${routeInfo.risky.distanceKm.toFixed(
                      1
                    )} km`}
                  />

                  <AnalysisCard
                    icon="👥"
                    title="Route time"
                    value={`${routeInfo.risky.durationMin} min`}
                  />

                  <AnalysisCard
                    icon="⚠"
                    title="Risk score"
                    value={
                      getRiskScoreForRoute(
                        routeInfo.risky
                      ) == null
                        ? "Data pending"
                        : `${getRiskScoreForRoute(
                            routeInfo.risky
                          )}/100`
                    }
                  />

                  <AnalysisCard
                    icon="📍"
                    title="Nearby places"
                    value={`${nearbyPlaces.length}`}
                  />
                </View>

                {/* ==================================================
                    SHARE
                ================================================== */}

                {/* ==================================================
                    START NAVIGATION
                ================================================== */}

                <Pressable
                  style={
                    styles.startNavigationButton
                  }
                  onPress={() =>
                    setShowNavigation(true)
                  }
                >
                  <Text
                    style={
                      styles.startNavigationText
                    }
                  >
                    Start Navigation
                  </Text>

                  <Text
                    style={
                      styles.startNavigationArrow
                    }
                  >
                    →
                  </Text>
                </Pressable>
              </>
            )}
        </ScrollView>

        <BottomNav
          active="Explore"
          onHome={onBack}
          onExplore={onExplore}
          onSOS={onSOS}
          onProfile={onProfile}
        />
      </View>
    </SafeAreaView>
  );
}

/* ============================================================
   NAVIGATION SCREEN
============================================================ */

function NavigationScreen({
  start,
  destination,
  route,
  startText,
  destinationText,
  routeKind,
  onBack,
  onExplore,
  onSOS,
  contacts,
  onProfile,
}: {
  start: GeoPoint;
  destination: GeoPoint;
  route: RouteData;
  startText: string;
  destinationText: string;
  routeKind: RouteKind;
  onBack: () => void;
  onExplore: () => void;
  onSOS: () => void;
  contacts: EmergencyContact[];
  onProfile: () => void;
}) {
  const navigationMapRef =
    useRef<MapView | null>(null);

  // Tap the navigation map to switch between the normal preview
  // and the taller, active-navigation style map.
  const [isMapExpanded, setIsMapExpanded] =
    useState(false);

  // Real phone GPS state. This is deliberately NOT simulated.
  const [currentLocation, setCurrentLocation] =
    useState<Point | null>(null);

  const [locationHeading, setLocationHeading] =
    useState(0);

  const [locationStatus, setLocationStatus] =
    useState(
      "Waiting for your phone location…"
    );

  const [remainingDistanceKm, setRemainingDistanceKm] =
    useState(route.distanceKm);

  const [offRoute, setOffRoute] =
    useState(false);

  const locationSubscription =
    useRef<Location.LocationSubscription | null>(
      null
    );

  const lastLocationRef =
    useRef<Point | null>(null);

  const routeLabel =
    routeKind === "safer"
      ? "Safer Route"
      : routeKind === "fastest"
      ? "Fastest Route"
      : "Riskier Route";

  const routeColor =
    routeKind === "safer"
      ? COLORS.green
      : routeKind === "fastest"
      ? COLORS.pink
      : COLORS.red;

  const riskScore =
    route.riskScore == null
      ? null
      : Math.round(route.riskScore);

  const safetyScore =
    route.safetyScore == null
      ? null
      : Math.round(route.safetyScore);

  const region = getRegion(
    start,
    destination
  );

  /*
    Start foreground GPS tracking.

    The marker only changes when Expo Location reports a
    new position from the real device. There is no timer,
    interpolation, fake coordinate or automatic movement.
  */
  useEffect(() => {
    let mounted = true;

    const startLiveLocation = async () => {
      try {
        setLocationStatus(
          "Requesting location permission…"
        );

        const permission =
          await Location.requestForegroundPermissionsAsync();

        if (
          permission.status !==
          "granted"
        ) {
          if (mounted) {
            setLocationStatus(
              "Location permission is required for live navigation."
            );
          }

          Alert.alert(
            "Location permission needed",
            "Allow Securia to access your location while using the app so the navigation marker can follow your real movement."
          );

          return;
        }

        setLocationStatus(
          "Getting your live location…"
        );

        const initialPosition =
          await Location.getCurrentPositionAsync(
            {
              accuracy:
                Location.Accuracy.High,
            }
          );

        if (!mounted) return;

        const initialPoint: Point = {
          latitude:
            initialPosition.coords.latitude,
          longitude:
            initialPosition.coords.longitude,
        };

        const initialHeading =
          Number.isFinite(
            initialPosition.coords.heading ??
              NaN
          ) &&
          (initialPosition.coords.heading ?? -1) >=
            0
            ? (initialPosition.coords.heading as number)
            : 0;

        lastLocationRef.current =
          initialPoint;

        setCurrentLocation(
          initialPoint
        );
        setLocationHeading(
          initialHeading
        );

        const initialNearest =
          getNearestRouteIndex(
            initialPoint,
            route.coordinates
          );

        const initialRemaining =
          getRemainingRouteDistanceKm(
            initialPoint,
            route.coordinates
          );

        setRemainingDistanceKm(
          Math.min(
            route.distanceKm,
            Math.max(0, initialRemaining)
          )
        );

        setOffRoute(
          initialNearest.distanceMeters >
            60
        );

        setLocationStatus(
          initialNearest.distanceMeters >
            60
            ? "Live GPS active • You are off the selected route."
            : "Live GPS active • Following your selected route."
        );

        locationSubscription.current =
          await Location.watchPositionAsync(
            {
              accuracy:
                Location.Accuracy.High,
              timeInterval: 1000,
              distanceInterval: 2,
              mayShowUserSettingsDialog: true,
            },
            (location) => {
              if (!mounted) return;

              const nextPoint: Point = {
                latitude:
                  location.coords.latitude,
                longitude:
                  location.coords.longitude,
              };

              const previousPoint =
                lastLocationRef.current;

              let nextHeading =
                location.coords.heading;

              if (
                nextHeading == null ||
                nextHeading < 0
              ) {
                if (
                  previousPoint &&
                  pointDistanceMeters(
                    previousPoint,
                    nextPoint
                  ) >= 2
                ) {
                  nextHeading =
                    getBearingDegrees(
                      previousPoint,
                      nextPoint
                    );
                } else {
                  nextHeading =
                    locationHeading;
                }
              }

              lastLocationRef.current =
                nextPoint;

              setCurrentLocation(
                nextPoint
              );
              setLocationHeading(
                nextHeading
              );

              const nearest =
                getNearestRouteIndex(
                  nextPoint,
                  route.coordinates
                );

              const remaining =
                getRemainingRouteDistanceKm(
                  nextPoint,
                  route.coordinates
                );

              const safeRemaining =
                Math.min(
                  route.distanceKm,
                  Math.max(0, remaining)
                );

              setRemainingDistanceKm(
                safeRemaining
              );

              const isOffRoute =
                nearest.distanceMeters >
                60;

              setOffRoute(
                isOffRoute
              );

              setLocationStatus(
                isOffRoute
                  ? "Live GPS active • You are off the selected route."
                  : "Live GPS active • Following your selected route."
              );

              /*
                The map follows ONLY the actual GPS position.
                It does not move unless a real location update
                arrives from the phone.
              */
              navigationMapRef.current?.animateCamera(
                {
                  center: nextPoint,
                  zoom: isMapExpanded
                    ? 17
                    : 16,
                  pitch: 0,
                },
                {
                  duration: 700,
                }
              );
            }
          );
      } catch (error) {
        if (!mounted) return;

        setLocationStatus(
          "Unable to read your live location."
        );

        Alert.alert(
          "Location unavailable",
          "Securia could not access the phone's current location. Please check that Location Services are enabled."
        );
      }
    };

    startLiveLocation();

    return () => {
      mounted = false;

      if (
        locationSubscription.current
      ) {
        locationSubscription.current.remove();
        locationSubscription.current =
          null;
      }
    };
  }, [route]);

  /*
    Fit the complete route when the screen first opens.
    The Recenter button below uses the live GPS position
    once it is available.
  */
  const fitRoute = () => {
    if (
      currentLocation &&
      navigationMapRef.current
    ) {
      navigationMapRef.current.animateCamera(
        {
          center: currentLocation,
          zoom: 17,
          pitch: 0,
        },
        {
          duration: 500,
        }
      );

      return;
    }

    navigationMapRef.current?.fitToCoordinates(
      [
        start,
        destination,
        ...route.coordinates,
      ],
      {
        edgePadding: {
          top: isMapExpanded ? 145 : 100,
          right: 45,
          bottom: isMapExpanded ? 155 : 180,
          left: 45,
        },
        animated: true,
      }
    );
  };

  useEffect(() => {
    const timer = setTimeout(
      fitRoute,
      isMapExpanded ? 250 : 350
    );

    return () =>
      clearTimeout(timer);
  }, [
    route,
    start,
    destination,
    isMapExpanded,
  ]);

  const remainingTimeMin =
    route.distanceKm > 0
      ? Math.max(
          1,
          Math.round(
            route.durationMin *
              (remainingDistanceKm /
                route.distanceKm)
          )
        )
      : route.durationMin;

  const handleEmergency = async () => {
  try {
    // Get saved emergency contacts
    const phoneNumbers = contacts
      .filter((contact) => contact.phone.trim().length > 0)
      .map((contact) => contact.phone.trim());

    if (phoneNumbers.length === 0) {
      Alert.alert(
        "No Emergency Contacts",
        "Please add emergency contacts in your Profile first."
      );
      return;
    }

    // Check location permission
    const { status } =
      await Location.requestForegroundPermissionsAsync();

    if (status !== "granted") {
      Alert.alert(
        "Location Permission Required",
        "Please allow location access to share your location."
      );
      return;
    }

    // Get current GPS location
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    const { latitude, longitude } = position.coords;

    const mapLink =
      `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

    const message =
      `EMERGENCY ALERT! I need help. This is my current location: ${mapLink}`;

    // Check SMS availability
    const available = await SMS.isAvailableAsync();

    if (!available) {
      Alert.alert(
        "SMS Unavailable",
        "SMS is not available on this device."
      );
      return;
    }

    // Open SMS with all emergency contacts
    await SMS.sendSMSAsync(phoneNumbers, message);

  } catch (error) {
    console.error("Emergency alert error:", error);

    Alert.alert(
      "Emergency Alert",
      "Unable to prepare the emergency message. Please try again."
    );
  }
};

  return (
    <SafeAreaView
      style={styles.safeArea}
    >
      <View
        style={
          styles.navigationContainer
        }
      >
        {/* HEADER */}

        <View
          style={
            styles.navigationHeader
          }
        >
          <Pressable
            onPress={onBack}
            style={
              styles.navigationBackButton
            }
          >
            <Text
              style={
                styles.navigationBackArrow
              }
            >
              ‹
            </Text>
          </Pressable>

          <View
            style={
              styles.navigationHeaderText
            }
          >
            <Text
              style={
                styles.navigationEyebrow
              }
            >
              NAVIGATION
            </Text>

            <Text
              style={
                styles.navigationTitle
              }
              numberOfLines={1}
            >
              {destinationText}
            </Text>
          </View>

          <View
            style={[
              styles.navigationRouteBadge,
              {
                borderColor:
                  routeColor,
              },
            ]}
          >
            <Text
              style={[
                styles.navigationRouteBadgeText,
                {
                  color:
                    routeColor,
                },
              ]}
            >
              {routeLabel}
            </Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={
            styles.navigationScroll
          }
        >
          {/* MAP */}

          <View
            style={[
              styles.navigationMapCard,
              isMapExpanded &&
                styles.navigationMapCardExpanded,
            ]}
          >
            <MapView
              ref={
                navigationMapRef
              }
              style={
                styles.navigationMap
              }
              initialRegion={
                region
              }
              showsCompass
              showsUserLocation={false}
              showsMyLocationButton={false}
              onPress={() =>
                setIsMapExpanded(
                  (current) => !current
                )
              }
            >
              <Polyline
                coordinates={
                  route.coordinates
                }
                strokeWidth={8}
                strokeColor={
                  routeColor
                }
                lineCap="round"
                lineJoin="round"
              />

              {/* ORIGINAL START POINT */}
              <Marker
                coordinate={
                  start
                }
                title="Starting point"
                description={
                  startText
                }
              >
                <View
                  style={
                    styles.navigationStartMarker
                  }
                >
                  <View
                    style={
                      styles.navigationStartDot
                    }
                  />
                </View>
              </Marker>

              {/* REAL PHONE GPS MARKER */}
              {currentLocation && (
                <Marker
                  coordinate={
                    currentLocation
                  }
                  title="Your current location"
                  description={
                    locationStatus
                  }
                  rotation={
                    locationHeading
                  }
                  flat
                  anchor={{
                    x: 0.5,
                    y: 0.5,
                  }}
                >
                  <View
                    style={
                      styles.liveLocationMarker
                    }
                  >
                    <View
                      style={
                        styles.liveLocationArrow
                      }
                    >
                      <Text
                        style={
                          styles.liveLocationArrowText
                        }
                      >
                        ▲
                      </Text>
                    </View>

                    <View
                      style={
                        styles.liveLocationCore
                      }
                    />
                  </View>
                </Marker>
              )}

              <Marker
                coordinate={
                  destination
                }
                title="Destination"
                description={
                  destinationText
                }
              >
                <View
                  style={
                    styles.navigationDestinationMarker
                  }
                >
                  <Text
                    style={
                      styles.navigationDestinationMarkerText
                    }
                  >
                    ●
                  </Text>
                </View>
              </Marker>
            </MapView>

            {isMapExpanded && (
              <>
                {/* ACTIVE NAVIGATION INSTRUCTION */}
                <View
                  style={
                    styles.navigationExpandedTopCard
                  }
                  pointerEvents="none"
                >
                  <View
                    style={
                      styles.navigationExpandedTurnIcon
                    }
                  >
                    <Text
                      style={
                        styles.navigationExpandedTurnIconText
                      }
                    >
                      ↑
                    </Text>
                  </View>

                  <View
                    style={
                      styles.navigationExpandedTopText
                    }
                  >
                    <Text
                      style={
                        styles.navigationExpandedDistance
                      }
                    >
                      {remainingDistanceKm.toFixed(1)} km
                    </Text>

                    <Text
                      style={
                        styles.navigationExpandedInstruction
                      }
                      numberOfLines={1}
                    >
                      Continue toward {destinationText}
                    </Text>
                  </View>
                </View>

                {/* ACTIVE NAVIGATION BOTTOM BAR */}
                <View
                  style={
                    styles.navigationExpandedBottomCard
                  }
                >
                  <View
                    style={
                      styles.navigationExpandedBottomStats
                    }
                  >
                    <Text
                      style={
                        styles.navigationExpandedBottomMain
                      }
                    >
                      {remainingDistanceKm.toFixed(1)} km
                    </Text>

                    <Text
                      style={
                        styles.navigationExpandedBottomSub
                      }
                    >
                      {remainingTimeMin} min remaining
                    </Text>
                  </View>

                  <Pressable
                    style={
                      styles.navigationExpandedEndButton
                    }
                    onPress={onBack}
                  >
                    <Text
                      style={
                        styles.navigationExpandedEndText
                    }
                    >
                      End
                    </Text>
                  </Pressable>
                </View>

                {/* SAFETY STATUS */}
                <View
                  style={[
                    styles.navigationExpandedSafetyBar,
                    {
                      borderColor:
                        routeColor,
                    },
                  ]}
                  pointerEvents="none"
                >
                  <Text
                    style={[
                      styles.navigationExpandedSafetyIcon,
                      {
                        color: routeColor,
                      },
                    ]}
                  >
                    ♥
                  </Text>

                  <Text
                    style={
                      styles.navigationExpandedSafetyText
                    }
                  >
                    {offRoute
                      ? "You're off the selected route"
                      : routeKind === "riskier"
                      ? "You're on the riskier route"
                      : "You're on a safer route"}
                  </Text>
                </View>

                {/* COLLAPSE HINT */}
                <View
                  style={
                    styles.navigationExpandedCollapseHint
                  }
                  pointerEvents="none"
                >
                  <Text
                    style={
                      styles.navigationExpandedCollapseHintText
                    }
                  >
                    Tap map to collapse
                  </Text>
                </View>
              </>
            )}

            <View
              style={[
                styles.navigationPreviewBadge,
                isMapExpanded &&
                  styles.navigationPreviewBadgeExpanded,
              ]}
            >
              <Text
                style={
                  styles.navigationPreviewBadgeText
                }
              >
                {isMapExpanded
                  ? "ACTIVE NAVIGATION"
                  : "Route guidance preview"}
              </Text>
            </View>

            <Pressable
              style={
                styles.navigationRecenter
              }
              onPress={
                fitRoute
              }
            >
              <Text
                style={
                  styles.navigationRecenterIcon
                }
              >
                ◎
              </Text>

              <Text
                style={
                  styles.navigationRecenterText
                }
              >
                Recenter
              </Text>
            </Pressable>
          </View>

          {/* ROUTE SUMMARY */}

          <View
            style={
              styles.navigationSummaryCard
            }
          >
            <View
              style={
                styles.navigationSummaryTop
              }
            >
              <View
                style={
                  styles.navigationShield
                }
              >
                <Text
                  style={
                    styles.navigationShieldText
                  }
                >
                  🛡
                </Text>
              </View>

              <View
                style={
                  styles.navigationSummaryTitleBox
                }
              >
                <Text
                  style={
                    styles.navigationSummaryTitle
                  }
                >
                  {routeLabel}
                </Text>

                <Text
                  style={
                    styles.navigationSummarySubtitle
                  }
                  numberOfLines={1}
                >
                  {startText} → {destinationText}
                </Text>
              </View>
            </View>

            <View
              style={
                styles.navigationStatsRow
              }
            >
              <View
                style={
                  styles.navigationStat
                }
              >
                <Text
                  style={
                    styles.navigationStatValue
                  }
                >
                  {remainingDistanceKm.toFixed(
                    1
                  )} km
                </Text>

                <Text
                  style={
                    styles.navigationStatLabel
                  }
                >
                  Distance
                </Text>
              </View>

              <View
                style={
                  styles.navigationStatDivider
                }
              />

              <View
                style={
                  styles.navigationStat
                }
              >
                <Text
                  style={
                    styles.navigationStatValue
                  }
                >
                  {remainingTimeMin} min
                </Text>

                <Text
                  style={
                    styles.navigationStatLabel
                  }
                >
                  Remaining time
                </Text>
              </View>

              <View
                style={
                  styles.navigationStatDivider
                }
              />

              <View
                style={
                  styles.navigationStat
                }
              >
                <Text
                  style={[
                    styles.navigationStatValue,
                    {
                      color:
                        routeColor,
                    },
                  ]}
                >
                  {riskScore == null
                    ? "--"
                    : riskScore}
                </Text>

                <Text
                  style={
                    styles.navigationStatLabel
                  }
                >
                  Risk / 100
                </Text>
              </View>
            </View>
          </View>

          {/* LIVE GPS STATUS */}

          <View
            style={[
              styles.navigationLiveLocationCard,
              {
                borderColor:
                  offRoute
                    ? COLORS.red
                    : COLORS.goldBorder,
              },
            ]}
          >
            <View
              style={
                styles.navigationLiveLocationDot
              }
            />

            <View
              style={
                styles.navigationLiveLocationBody
              }
            >
              <Text
                style={
                  styles.navigationLiveLocationTitle
                }
              >
                {offRoute
                  ? "OFF ROUTE"
                  : currentLocation
                  ? "LIVE GPS ACTIVE"
                  : "LOCATING YOU"}
              </Text>

              <Text
                style={
                  styles.navigationLiveLocationText
                }
              >
                {locationStatus}
              </Text>
            </View>

            <Text
              style={
                styles.navigationLiveLocationDistance
              }
            >
              {remainingDistanceKm.toFixed(1)} km
            </Text>
          </View>

          {/* NEXT GUIDANCE */}

          <View
            style={
              styles.navigationInstructionCard
            }
          >
            <View
              style={
                styles.navigationInstructionIcon
              }
            >
              <Text
                style={
                  styles.navigationInstructionIconText
                }
              >
                ➜
              </Text>
            </View>

            <View
              style={
                styles.navigationInstructionBody
              }
            >
              <Text
                style={
                  styles.navigationInstructionLabel
                }
              >
                FOLLOW HIGHLIGHTED ROUTE
              </Text>

              <Text
                style={
                  styles.navigationInstructionTitle
                }
              >
                Continue toward your destination
              </Text>

              <Text
                style={
                  styles.navigationInstructionText
                }
              >
                Your real phone location is shown with
                the blue navigation marker. The marker
                updates only when your device reports a
                new GPS position. Turn-by-turn voice
                guidance can be added separately.
              </Text>
            </View>
          </View>

          {/* SAFETY STATUS */}

          <View
            style={
              styles.navigationSafetyCard
            }
          >
            <View
              style={
                styles.navigationSafetyHeader
              }
            >
              <Text
                style={
                  styles.navigationSafetyTitle
                }
              >
                Safety status
              </Text>

              <Text
                style={[
                  styles.navigationSafetyScore,
                  {
                    color:
                      routeColor,
                  },
                ]}
              >
                {safetyScore == null
                  ? "Data pending"
                  : `${safetyScore}%`}
              </Text>
            </View>

            <Text
              style={
                styles.navigationSafetyText
              }
            >
              Route safety is based on the same
              available OpenStreetMap indicators used
              in Route Analysis.
            </Text>

            <View
              style={
                styles.navigationSafetyBar
              }
            >
              <View
                style={[
                  styles.navigationSafetyBarFill,
                  {
                    width:
                      `${safetyScore == null
                        ? 0
                        : safetyScore}%`,
                    backgroundColor:
                      routeColor,
                  },
                ]}
              />
            </View>
          </View>

          {/* CONTROLS */}

          <Pressable
            style={
              styles.navigationSOSButton
            }
            onPress={
              handleEmergency
            }
          >
            <Text
              style={
                styles.navigationSOSIcon
              }
            >
              ⚠
            </Text>

            <View
              style={
                styles.navigationSOSTextBox
              }
            >
              <Text
                style={
                  styles.navigationSOSTitle
                }
              >
                Emergency
              </Text>

              <Text
                style={
                  styles.navigationSOSSubtitle
                }
              >
                Get help quickly
              </Text>
            </View>

            <Text
              style={
                styles.navigationSOSArrow
              }
            >
              →
            </Text>
          </Pressable>

          <Pressable
            style={
              styles.navigationEndButton
            }
            onPress={
              onBack
            }
          >
            <Text
              style={
                styles.navigationEndText
              }
            >
              End Navigation
            </Text>
          </Pressable>

          <Text
            style={
              styles.navigationFooterNote
            }
          >
            Live location uses the phone's foreground GPS.
            The blue marker moves only when your device
            reports a real position. Rerouting, voice
            guidance and turn-by-turn instructions can
            be connected separately.
          </Text>
        </ScrollView>

        <BottomNav
          active="Explore"
          onHome={onBack}
          onExplore={onExplore}
          onSOS={onSOS}
          onProfile={onProfile}
        />
      </View>
    </SafeAreaView>
  );
}

/* ============================================================
   RISKIOMETER
============================================================ */


function Riskometer({
  score,
}: {
  score: number | null;
}) {
  const safeScore =
    score == null
      ? null
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(score)
          )
        );

  const riskLabel =
    safeScore == null
      ? "Safety data pending"
      : safeScore <= 35
      ? "Low Risk"
      : safeScore <= 65
      ? "Moderate Risk"
      : "High Risk";

  const riskColor =
    safeScore == null
      ? COLORS.gold
      : safeScore <= 35
      ? COLORS.green
      : safeScore <= 65
      ? COLORS.pink
      : COLORS.red;

  /*
    Gauge range:

    -70° = left
      0° = center
    +70° = right
  */

  const angle =
    safeScore == null
      ? 0
      : -70 +
        (safeScore / 100) *
          140;

  /*
    Fixed pivot point.
  */

  const pivotX = 36;
  const pivotY = 40;

  const needleLength = 38;

  const radians =
    (angle * Math.PI) /
    180;

  const endX =
    pivotX +
    Math.sin(radians) *
      needleLength;

  const endY =
    pivotY -
    Math.cos(radians) *
      needleLength;

  const midpointX =
    (pivotX + endX) /
    2;

  const midpointY =
    (pivotY + endY) /
    2;

  return (
    <View
      style={
        styles.riskometerContainer
      }
    >
      {/* TITLE */}

      <Text
        style={
          styles.riskometerTitle
        }
      >
        Riskiometer
      </Text>

      <View
        style={
          styles.riskometerBody
        }
      >
        {/* GAUGE */}

        <View
          style={
            styles.gaugeWrapper
          }
        >
          <View
            style={
              styles.gaugeOuter
            }
          >
            {/* INNER ARC */}

            <View
              style={
                styles.gaugeInner
              }
            />

            {/* NEEDLE */}

            <View
              style={[
                styles.gaugeNeedleFixed,
                {
                  left:
                    midpointX -
                    1.5,

                  top:
                    midpointY -
                    needleLength /
                      2,

                  transform: [
                    {
                      rotate: `${angle}deg`,
                    },
                  ],
                },
              ]}
            />

            {/* CENTER */}

            <View
              style={[
                styles.needleCenterFixed,
                {
                  left:
                    pivotX - 6,

                  top:
                    pivotY - 6,
                },
              ]}
            />
          </View>
        </View>

        {/* SCORE */}

        <View
          style={
            styles.riskScoreContainer
          }
        >
          <Text
            style={[
              styles.riskScore,
              {
                color:
                  riskColor,
              },
            ]}
          >
            {safeScore == null ? "--" : safeScore}

            <Text
              style={
                styles.riskScoreTotal
              }
            >
              /100
            </Text>
          </Text>

          <View
            style={[
              styles.riskBadge,
              {
                backgroundColor:
                  riskColor,
              },
            ]}
          >
            <Text
              style={
                styles.riskBadgeText
              }
            >
              {riskLabel}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

/* ============================================================
   ROUTE OPTION
============================================================ */

function RouteOption({
  title,
  badge,
  route,
  icon,
  color,
  description,
  danger,
  riskScore,
  onPress,
}: {
  title: string;
  badge?: string;
  route: RouteData;
  icon: string;
  color: string;
  description: string;
  danger?: boolean;
  riskScore: number | null;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.routeOption,
        {
          borderColor:
            color,

          backgroundColor:
            danger
              ? COLORS.redBg
              : COLORS.card,
        },
      ]}
    >
      {/* LEFT */}

      <View
        style={
          styles.routeLeft
        }
      >
        <Text
          style={[
            styles.routeOptionIcon,
            {
              color,
            },
          ]}
        >
          {icon}
        </Text>

        <View
          style={
            styles.routeOptionContent
          }
        >
          <View
            style={
              styles.routeTitleRow
            }
          >
            <Text
              style={[
                styles.routeOptionTitle,
                {
                  color,
                },
              ]}
            >
              {title}
            </Text>

            {badge && (
              <View
                style={
                  styles.recommendedBadge
                }
              >
                <Text
                  style={
                    styles.recommendedText
                  }
                >
                  {badge}
                </Text>
              </View>
            )}
          </View>

          <Text
            style={
              styles.routeStats
            }
          >
            {route.durationMin}{" "}
            min
            {"  |  "}
            {route.distanceKm.toFixed(
              1
            )}{" "}
            km
          </Text>

          <Text
            style={
              styles.routeDescription
            }
          >
            {description}
          </Text>
        </View>
      </View>

      {/* RISKIOMETER */}

      <Riskometer
        score={
          riskScore
        }
      />

      {/* CHEVRON */}

      <Text
        style={
          styles.routeChevron
        }
      >
        ›
      </Text>
    </Pressable>
  );
}

/* ============================================================
   INSIGHT
============================================================ */

function Insight({
  icon,
  value,
  label,
}: {
  icon: string;
  value: string;
  label: string;
}) {
  return (
    <View
      style={
        styles.insightCard
      }
    >
      <Text
        style={
          styles.insightIcon
        }
      >
        {icon}
      </Text>

      <Text
        style={
          styles.insightValue
        }
      >
        {value}
      </Text>

      <Text
        style={
          styles.insightLabel
        }
      >
        {label}
      </Text>
    </View>
  );
}

/* ============================================================
   ANALYSIS CARD
============================================================ */

function AnalysisCard({
  icon,
  title,
  value,
}: {
  icon: string;
  title: string;
  value: string;
}) {
  return (
    <View
      style={
        styles.analysisCard
      }
    >
      <Text
        style={
          styles.analysisIcon
        }
      >
        {icon}
      </Text>

      <Text
        style={
          styles.analysisValue
        }
      >
        {value}
      </Text>

      <Text
        style={
          styles.analysisTitle
        }
      >
        {title}
      </Text>
    </View>
  );
}

/* ============================================================
   NEARBY CARD
============================================================ */

function NearbyCard({
  place,
}: {
  place: NearbyPlace;
}) {
  const icon =
    place.type === "Police"
      ? "🛡"
      : place.type ===
          "Hospital" ||
        place.type ===
          "Clinic"
      ? "✚"
      : place.type ===
          "Pharmacy"
      ? "💊"
      : place.type ===
          "Fuel"
      ? "⛽"
      : "☕";

  return (
    <View
      style={
        styles.nearbyCard
      }
    >
      <View
        style={
          styles.placeImagePlaceholder
        }
      >
        <Text
          style={
            styles.placeIcon
          }
        >
          {icon}
        </Text>
      </View>

      <Text
        style={
          styles.placeName
        }
        numberOfLines={1}
      >
        {place.name}
      </Text>

      <Text
        style={
          styles.placeDistance
        }
      >
        {place.distanceKm.toFixed(
          1
        )}{" "}
        km •{" "}
        <Text
          style={
            styles.openText
          }
        >
          Nearby
        </Text>
      </Text>
    </View>
  );
}

/* ============================================================
   SAFETY LAWS
============================================================ */

type SafetyLaw = {
  icon: string;
  title: string;
  section: string;
  punishment: string;
  detail: string;
};

const SAFETY_LAWS: SafetyLaw[] = [
  {
    icon: "▣",
    title: "Sexual harassment",
    section: "BNS Sec. 75",
    punishment: "Up to 3 years + fine",
    detail:
      "Punishment depends on the type of offence; some forms carry up to 3 years and sexually coloured remarks can carry up to 1 year, with fine.",
  },
  {
    icon: "✋",
    title: "Assault to disrobe",
    section: "BNS Sec. 76",
    punishment: "3 to 7 years + fine",
    detail:
      "Assault or criminal force against a woman with intent to disrobe her is punishable with imprisonment from 3 to 7 years and fine.",
  },
  {
    icon: "◉",
    title: "Voyeurism",
    section: "BNS Sec. 77",
    punishment: "1–3 years + fine; repeat: 3–7 years + fine",
    detail:
      "Secretly watching or recording a woman in a private act, or sharing such an image, can attract the stated punishment.",
  },
  {
    icon: "👥",
    title: "Stalking",
    section: "BNS Sec. 78",
    punishment: "Up to 3 years + fine; repeat: up to 5 years + fine",
    detail:
      "Repeatedly following, contacting, or monitoring a woman despite a clear lack of interest can amount to stalking, subject to the legal exceptions.",
  },
  {
    icon: "💬",
    title: "Insulting modesty",
    section: "BNS Sec. 79",
    punishment: "Up to 3 years + fine",
    detail:
      "Words, sounds, gestures, or acts intended to insult a woman's modesty can attract imprisonment up to 3 years and fine.",
  },
];

function SafetyLaws() {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <View
      style={
        styles.lawsCard
      }
    >
      <View
        style={
          styles.lawsCardHeader
        }
      >
        <Text
          style={
            styles.lawsIcon
          }
        >
          ⚖
        </Text>

        <View
          style={
            styles.lawsHeaderText
          }
        >
          <Text
            style={
              styles.lawsTitle
            }
          >
            Safety Laws
          </Text>

          <Text
            style={
              styles.lawsSubtitle
            }
          >
            Key acts and punishments
          </Text>
        </View>
      </View>

      {SAFETY_LAWS.map(
        (law, index) => {
          const isExpanded =
            expanded === index;

          return (
            <Pressable
              key={law.section}
              style={[
                styles.lawRow,
                isExpanded &&
                  styles.lawRowExpanded,
              ]}
              onPress={() =>
                setExpanded(
                  isExpanded
                    ? null
                    : index
                )
              }
            >
              <View
                style={
                  styles.lawIconCircle
                }
              >
                <Text
                  style={
                    styles.lawRowIcon
                  }
                >
                  {law.icon}
                </Text>
              </View>

              <View
                style={
                  styles.lawMain
                }
              >
                <Text
                  style={
                    styles.lawName
                  }
                  numberOfLines={
                    isExpanded
                      ? undefined
                      : 1
                  }
                >
                  {law.title}
                </Text>

                <Text
                  style={
                    styles.lawSection
                  }
                >
                  {law.section}
                </Text>

                <Text
                  style={
                    styles.lawPunishment
                  }
                >
                  {law.punishment}
                </Text>

                {isExpanded && (
                  <Text
                    style={
                      styles.lawDetail
                    }
                  >
                    {law.detail}
                  </Text>
                )}
              </View>

              <Text
                style={
                  styles.lawChevron
                }
              >
                {isExpanded
                  ? "⌃"
                  : "›"}
              </Text>
            </Pressable>
          );
        }
      )}

      <Text
        style={
          styles.lawDisclaimer
        }
      >
        General information only • Laws may change • Verify with official sources
      </Text>
    </View>
  );
}

/* ============================================================
   HELPLINE CARD
============================================================ */

function HelplineCard({
  icon,
  value,
  label,
  sublabel,
}: {
  icon: string;
  value: string;
  label: string;
  sublabel: string;
}) {
  return (
    <Pressable
      style={
        styles.helplineCard
      }
      onPress={() =>
        Alert.alert(
          label,
          `${value} • ${sublabel}`
        )
      }
    >
      <Text
        style={
          styles.helplineIcon
        }
      >
        {icon}
      </Text>

      <Text
        style={
          styles.helplineValue
        }
      >
        {value}
      </Text>

      <Text
        style={
          styles.helplineLabel
        }
        numberOfLines={2}
      >
        {label}
      </Text>

      <Text
        style={
          styles.helplineSub
        }
        numberOfLines={2}
      >
        {sublabel}
      </Text>
    </Pressable>
  );
}


/* ============================================================
   REPORT INCIDENT SCREEN
============================================================ */

function ReportIncidentScreen({
  onBack,
  onExplore,
  onSOS,
  onProfile,
}: {
  onBack: () => void;
  onExplore: () => void;
  onSOS: () => void;
  onProfile: () => void;
}) {
  const [
    useCurrentLocation,
    setUseCurrentLocation,
  ] = useState(false);

  const [
    locating,
    setLocating,
  ] = useState(false);

  const [
    location,
    setLocation,
  ] = useState<Point | null>(
    null
  );

  const [
    incidentType,
    setIncidentType,
  ] = useState("");

  const [
    description,
    setDescription,
  ] = useState("");

  const [
    submitted,
    setSubmitted,
  ] = useState(false);

  const getCurrentLocation =
    async () => {
      try {
        setLocating(true);

        const {
          status,
        } =
          await Location.requestForegroundPermissionsAsync();

        if (status !== "granted") {
          Alert.alert(
            "Location permission needed",
            "Allow Securia to use your location or submit the report without a location."
          );
          return;
        }

        const current =
          await Location.getCurrentPositionAsync({
            accuracy:
              Location.Accuracy.High,
          });

        setLocation({
          latitude:
            current.coords.latitude,
          longitude:
            current.coords.longitude,
        });

        setUseCurrentLocation(
          true
        );
      } catch {
        Alert.alert(
          "Location unavailable",
          "Securia could not read the current location."
        );
      } finally {
        setLocating(false);
      }
    };

  const submitReport =
    () => {
      if (!incidentType) {
        Alert.alert(
          "Choose an incident type",
          "Select what you want to report."
        );
        return;
      }

      if (!description.trim()) {
        Alert.alert(
          "Add a description",
          "Briefly describe what happened or what makes the area unsafe."
        );
        return;
      }

      setSubmitted(true);
    };

  if (submitted) {
    return (
      <SafeAreaView
        style={
          styles.safeArea
        }
      >
        <View
          style={
            styles.reportSuccessScreen
          }
        >
          <View
            style={
              styles.reportSuccessIcon
            }
          >
            <Text
              style={
                styles.reportSuccessIconText
              }
            >
              ✓
            </Text>
          </View>

          <Text
            style={
              styles.reportSuccessTitle
            }
          >
            Report Submitted
          </Text>

          <Text
            style={
              styles.reportSuccessText
            }
          >
            Thank you for helping Securia identify safety concerns. The report is ready to be connected to the backend verification system.
          </Text>

          <Pressable
            style={
              styles.reportDoneButton
            }
            onPress={
              onBack
            }
          >
            <Text
              style={
                styles.reportDoneButtonText
              }
            >
              Back to Securia
            </Text>
          </Pressable>

          <View style={{ marginTop: 24, width: "100%" }}>
            <BottomNav
              active="Home"
              onHome={onBack}
              onExplore={onExplore}
              onSOS={onSOS}
              onProfile={onProfile}
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <KeyboardAvoidingView
        style={
          styles.editorScreen
        }
        behavior={
          Platform.OS ===
          "ios"
            ? "padding"
            : undefined
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.reportScroll
          }
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={
              styles.editorHeader
            }
          >
            <Pressable
              onPress={
                onBack
              }
              style={
                styles.editorBackButton
              }
            >
              <Text
                style={
                  styles.editorBackText
                }
              >
                ‹
              </Text>
            </Pressable>

            <Text
              style={
                styles.editorTitle
              }
            >
              Report an Incident
            </Text>

            <View
              style={
                styles.editorHeaderSpacer
              }
            />
          </View>

          <Text
            style={
              styles.reportIntro
            }
          >
            Help make routes safer by reporting safety concerns in your area.
          </Text>

          <View
            style={
              styles.reportCard
            }
          >
            <Text
              style={
                styles.formLabel
              }
            >
              Location
            </Text>

            <Pressable
              style={[
                styles.reportLocationButton,
                useCurrentLocation &&
                  styles.reportLocationActive,
              ]}
              onPress={
                getCurrentLocation
              }
              disabled={
                locating
              }
            >
              <Text
                style={
                  styles.reportLocationIcon
                }
              >
                📍
              </Text>

              <View
                style={
                  styles.reportLocationTextWrap
                }
              >
                <Text
                  style={
                    styles.reportLocationTitle
                  }
                >
                  {locating
                    ? "Getting location…"
                    : useCurrentLocation
                    ? "Current location selected"
                    : "Use current location"}
                </Text>

                <Text
                  style={
                    styles.reportLocationSubtitle
                  }
                >
                  {location
                    ? `${location.latitude.toFixed(
                        5
                      )}, ${location.longitude.toFixed(
                        5
                      )}`
                    : "Optional but useful for route safety analysis"}
                </Text>
              </View>
            </Pressable>

            <Text
              style={
                styles.formLabel
              }
            >
              Incident Type
            </Text>

            <View
              style={
                styles.incidentTypeGrid
              }
            >
              {[
                "Poor lighting",
                "Harassment",
                "Isolated area",
                "Suspicious activity",
                "Road/path issue",
                "Other",
              ].map(
                (type) => (
                  <Pressable
                    key={
                      type
                    }
                    style={[
                      styles.incidentTypeButton,
                      incidentType ===
                        type &&
                        styles.incidentTypeButtonActive,
                    ]}
                    onPress={() =>
                      setIncidentType(
                        type
                      )
                    }
                  >
                    <Text
                      style={[
                        styles.incidentTypeText,
                        incidentType ===
                          type &&
                          styles.incidentTypeTextActive,
                      ]}
                    >
                      {type}
                    </Text>
                  </Pressable>
                )
              )}
            </View>

            <Text
              style={
                styles.formLabel
              }
            >
              Description
            </Text>

            <TextInput
              style={
                styles.reportDescriptionInput
              }
              value={
                description
              }
              onChangeText={
                setDescription
              }
              placeholder="Describe what happened or what makes this area unsafe..."
              placeholderTextColor={
                COLORS.creamText
              }
              multiline
              textAlignVertical="top"
            />

            <View
              style={
                styles.reportTimeRow
              }
            >
              <Text
                style={
                  styles.reportTimeIcon
                }
              >
                🕐
              </Text>

              <Text
                style={
                  styles.reportTimeText
                }
              >
                Report time:{" "}
                {new Date().toLocaleString()}
              </Text>
            </View>

            <Pressable
              style={
                styles.reportSubmitButton
              }
              onPress={
                submitReport
              }
            >
              <Text
                style={
                  styles.reportSubmitText
                }
              >
                Submit Report
              </Text>

              <Text
                style={
                  styles.reportSubmitArrow
                }
              >
                →
              </Text>
            </Pressable>
          </View>
        </ScrollView>

        <BottomNav
          active="Home"
          onHome={onBack}
          onExplore={onExplore}
          onSOS={onSOS}
          onProfile={onProfile}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ============================================================
   SOS + PROFILE SCREENS
============================================================ */

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function isValidPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return /^\+?\d{10,15}$/.test(
    normalized
  );
}

function makeContactId(): string {
  return `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function ProfileScreen({
  profile,
  onProfileChange,
  contacts,
  onContactsChange,
  onBackHome,
  onExplore,
  onSOS,
  onProfile,
}: {
  profile: UserProfile;
  onProfileChange: (
    profile: UserProfile
  ) => void;
  contacts: EmergencyContact[];
  onContactsChange: (
    contacts: EmergencyContact[]
  ) => void;
  onBackHome: () => void;
  onExplore: () => void;
  onSOS: () => void;
  onProfile: () => void;
}) {
  const [
    editingProfile,
    setEditingProfile,
  ] = useState(false);

  const [
    editingContact,
    setEditingContact,
  ] = useState<EmergencyContact | null>(
    null
  );

  const [
    isAddingContact,
    setIsAddingContact,
  ] = useState(false);

  if (
    editingProfile
  ) {
    return (
      <ProfileEditorScreen
        profile={profile}
        onSave={(next) => {
          onProfileChange(next);
          setEditingProfile(false);
        }}
        onBack={() =>
          setEditingProfile(false)
        }
      />
    );
  }

  if (
    isAddingContact ||
    editingContact
  ) {
    return (
      <ContactEditorScreen
        contact={
          editingContact
        }
        onSave={(contact) => {
          if (editingContact) {
            onContactsChange(
              contacts.map((item) =>
                item.id ===
                contact.id
                  ? contact
                  : contact.primary
                  ? {
                      ...item,
                      primary: false,
                    }
                  : item
              )
            );
          } else {
            onContactsChange(
              contact.primary
                ? [
                    ...contacts.map(
                      (item) => ({
                        ...item,
                        primary: false,
                      })
                    ),
                    contact,
                  ]
                : [
                    ...contacts,
                    contact,
                  ]
            );
          }

          setEditingContact(null);
          setIsAddingContact(false);
        }}
        onBack={() => {
          setEditingContact(null);
          setIsAddingContact(false);
        }}
      />
    );
  }

  const deleteContact = (
    id: string
  ) => {
    Alert.alert(
      "Delete contact?",
      "This contact will be removed from Securia.",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const next =
              contacts.filter(
                (item) =>
                  item.id !== id
              );

            if (
              next.length &&
              !next.some(
                (item) =>
                  item.primary
              )
            ) {
              next[0] = {
                ...next[0],
                primary: true,
              };
            }

            onContactsChange(next);
          },
        },
      ]
    );
  };

  const callContact = async (
    phone: string
  ) => {
    const normalized =
      normalizePhone(phone);

    try {
      await Linking.openURL(
        `tel:${normalized}`
      );
    } catch {
      Alert.alert(
        "Unable to call",
        "The phone could not open the calling screen."
      );
    }
  };

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <View
        style={
          styles.profileScreen
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.profileScroll
          }
        >
          <View
            style={
              styles.profileHeader
            }
          >
            <View>
              <Text
                style={
                  styles.profileEyebrow
                }
              >
                SECURIA
              </Text>

              <Text
                style={
                  styles.profileHeading
                }
              >
                Profile
              </Text>
            </View>

            <Pressable
              style={
                styles.profileEditTopButton
              }
              onPress={() =>
                setEditingProfile(true)
              }
            >
              <Text
                style={
                  styles.profileEditTopText
                }
              >
                ✎
              </Text>
            </Pressable>
          </View>

          <View
            style={
              styles.profileHeroCard
            }
          >
            <View
              style={
                styles.profileAvatar
              }
            >
              <Text
                style={
                  styles.profileAvatarText
                }
              >
                {profile.name
                  ? profile.name
                      .trim()
                      .charAt(0)
                      .toUpperCase()
                  : "S"}
              </Text>
            </View>

            <Text
              style={
                styles.profileName
              }
            >
              {profile.name ||
                "Add your name"}
            </Text>

            <Text
              style={
                styles.profileSubtext
              }
            >
              {profile.phone ||
                "Add your phone number"}
            </Text>

            <Text
              style={
                styles.profileSubtext
              }
            >
              {profile.email ||
                "Add your email"}
            </Text>
          </View>

          <Text
            style={
              styles.profileSectionTitle
            }
          >
            My Details
          </Text>

          <Pressable
            style={
              styles.profileMenuCard
            }
            onPress={() =>
              setEditingProfile(true)
            }
          >
            <Text
              style={
                styles.profileMenuIcon
              }
            >
              👤
            </Text>

            <View
              style={
                styles.profileMenuTextWrap
              }
            >
              <Text
                style={
                  styles.profileMenuTitle
                }
              >
                Personal information
              </Text>

              <Text
                style={
                  styles.profileMenuSubtitle
                }
              >
                Name, phone and email
              </Text>
            </View>

            <Text
              style={
                styles.profileChevron
              }
            >
              ›
            </Text>
          </Pressable>

          <View
            style={
              styles.profileSectionRow
            }
          >
            <Text
              style={
                styles.profileSectionTitle
              }
            >
              Emergency Contacts
            </Text>

            <Text
              style={
                styles.contactCount
              }
            >
              {contacts.length}/5
            </Text>
          </View>

          {contacts.length === 0 ? (
            <View
              style={
                styles.emptyContactsCard
              }
            >
              <Text
                style={
                  styles.emptyContactsIcon
                }
              >
                👥
              </Text>

              <Text
                style={
                  styles.emptyContactsTitle
                }
              >
                No emergency contacts yet
              </Text>

              <Text
                style={
                  styles.emptyContactsText
                }
              >
                Add trusted people who can receive your emergency location.
              </Text>
            </View>
          ) : (
            contacts.map(
              (contact) => (
                <View
                  key={
                    contact.id
                  }
                  style={
                    styles.contactCard
                  }
                >
                  <View
                    style={
                      styles.contactAvatar
                    }
                  >
                    <Text
                      style={
                        styles.contactAvatarText
                      }
                    >
                      {contact.name
                        .trim()
                        .charAt(0)
                        .toUpperCase()}
                    </Text>
                  </View>

                  <View
                    style={
                      styles.contactInfo
                    }
                  >
                    <View
                      style={
                        styles.contactNameRow
                      }
                    >
                      <Text
                        style={
                          styles.contactName
                        }
                      >
                        {contact.name}
                      </Text>

                      {contact.primary && (
                        <View
                          style={
                            styles.primaryBadge
                          }
                        >
                          <Text
                            style={
                              styles.primaryBadgeText
                            }
                          >
                            PRIMARY
                          </Text>
                        </View>
                      )}
                    </View>

                    <Text
                      style={
                        styles.contactRelation
                      }
                    >
                      {contact.relation}
                    </Text>

                    <Text
                      style={
                        styles.contactPhone
                      }
                    >
                      {contact.phone}
                    </Text>
                  </View>

                  <View
                    style={
                      styles.contactActions
                    }
                  >
                    <Pressable
                      style={
                        styles.contactActionButton
                      }
                      onPress={() =>
                        callContact(
                          contact.phone
                        )
                      }
                    >
                      <Text>
                        ☎
                      </Text>
                    </Pressable>

                    <Pressable
                      style={
                        styles.contactActionButton
                      }
                      onPress={() => {
                        setEditingContact(
                          contact
                        );
                      }}
                    >
                      <Text>
                        ✎
                      </Text>
                    </Pressable>

                    <Pressable
                      style={[
                        styles.contactActionButton,
                        styles.contactDeleteButton,
                      ]}
                      onPress={() =>
                        deleteContact(
                          contact.id
                        )
                      }
                    >
                      <Text>
                        🗑
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )
            )
          )}

          <Pressable
            style={[
              styles.addContactButton,
              contacts.length >= 5 &&
                styles.disabledButton,
            ]}
            disabled={
              contacts.length >= 5
            }
            onPress={() =>
              setIsAddingContact(true)
            }
          >
            <Text
              style={
                styles.addContactButtonIcon
              }
            >
              +
            </Text>

            <Text
              style={
                styles.addContactButtonText
              }
            >
              {contacts.length >= 5
                ? "5 Contacts Added"
                : "Add Emergency Contact"}
            </Text>
          </Pressable>

          <View
            style={
              styles.profileInfoCard
            }
          >
            <Text
              style={
                styles.profileInfoTitle
              }
            >
              🚨 SOS setup
            </Text>

            <Text
              style={
                styles.profileInfoText
              }
            >
              Emergency contacts are saved on this device and can be used by the SOS screen.
            </Text>
          </View>
        </ScrollView>

        <BottomNav
          active="Profile"
          onHome={onBackHome}
          onExplore={onExplore}
          onSOS={onSOS}
          onProfile={onProfile}
        />
      </View>
    </SafeAreaView>
  );
}

function ProfileEditorScreen({
  profile,
  onSave,
  onBack,
}: {
  profile: UserProfile;
  onSave: (
    profile: UserProfile
  ) => void;
  onBack: () => void;
}) {
  const [name, setName] =
    useState(profile.name);

  const [phone, setPhone] =
    useState(profile.phone);

  const [email, setEmail] =
    useState(profile.email);

  const save = () => {
    if (!name.trim()) {
      Alert.alert(
        "Name required",
        "Please enter your name."
      );
      return;
    }

    if (
      phone.trim() &&
      !isValidPhone(phone)
    ) {
      Alert.alert(
        "Invalid phone number",
        "Enter a valid phone number with 10–15 digits."
      );
      return;
    }

    onSave({
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim(),
    });
  };

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <KeyboardAvoidingView
        style={
          styles.editorScreen
        }
        behavior={
          Platform.OS ===
          "ios"
            ? "padding"
            : undefined
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.editorScroll
          }
        >
          <View
            style={
              styles.editorHeader
            }
          >
            <Pressable
              onPress={onBack}
              style={
                styles.editorBackButton
              }
            >
              <Text
                style={
                  styles.editorBackText
                }
              >
                ‹
              </Text>
            </Pressable>

            <Text
              style={
                styles.editorTitle
              }
            >
              Edit Profile
            </Text>

            <View
              style={
                styles.editorHeaderSpacer
              }
            />
          </View>

          <View
            style={
              styles.editorAvatarLarge
            }
          >
            <Text
              style={
                styles.editorAvatarText
              }
            >
              {name
                ? name
                    .trim()
                    .charAt(0)
                    .toUpperCase()
                : "S"}
            </Text>
          </View>

          <View
            style={
              styles.editorCard
            }
          >
            <Text
              style={
                styles.formLabel
              }
            >
              Name
            </Text>

            <TextInput
              style={
                styles.formInput
              }
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor={
                COLORS.creamText
              }
            />

            <Text
              style={
                styles.formLabel
              }
            >
              Phone Number
            </Text>

            <TextInput
              style={
                styles.formInput
              }
              value={phone}
              onChangeText={setPhone}
              placeholder="+91 9876543210"
              placeholderTextColor={
                COLORS.creamText
              }
              keyboardType="phone-pad"
            />

            <Text
              style={
                styles.formLabel
              }
            >
              Email
            </Text>

            <TextInput
              style={
                styles.formInput
              }
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={
                COLORS.creamText
              }
              keyboardType="email-address"
              autoCapitalize="none"
            />

            <Pressable
              style={
                styles.saveButton
              }
              onPress={save}
            >
              <Text
                style={
                  styles.saveButtonText
                }
              >
                Save Changes
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ContactEditorScreen({
  contact,
  onSave,
  onBack,
}: {
  contact: EmergencyContact | null;
  onSave: (
    contact: EmergencyContact
  ) => void;
  onBack: () => void;
}) {
  const [name, setName] =
    useState(
      contact?.name || ""
    );

  const [relation, setRelation] =
    useState(
      contact?.relation || ""
    );

  const [phone, setPhone] =
    useState(
      contact?.phone || ""
    );

  const [primary, setPrimary] =
    useState(
      contact?.primary ?? false
    );

  const save = () => {
    if (!name.trim()) {
      Alert.alert(
        "Name required",
        "Please enter the contact name."
      );
      return;
    }

    if (!relation.trim()) {
      Alert.alert(
        "Relationship required",
        "Please enter the relationship."
      );
      return;
    }

    if (!isValidPhone(phone)) {
      Alert.alert(
        "Invalid phone number",
        "Enter a real phone number with 10–15 digits, for example +919876543210."
      );
      return;
    }

    onSave({
      id:
        contact?.id ||
        makeContactId(),
      name: name.trim(),
      relation: relation.trim(),
      phone: normalizePhone(
        phone
      ),
      primary,
    });
  };

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <KeyboardAvoidingView
        style={
          styles.editorScreen
        }
        behavior={
          Platform.OS ===
          "ios"
            ? "padding"
            : undefined
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.editorScroll
          }
        >
          <View
            style={
              styles.editorHeader
            }
          >
            <Pressable
              onPress={onBack}
              style={
                styles.editorBackButton
              }
            >
              <Text
                style={
                  styles.editorBackText
                }
              >
                ‹
              </Text>
            </Pressable>

            <Text
              style={
                styles.editorTitle
              }
            >
              {contact
                ? "Edit Contact"
                : "Add Contact"}
            </Text>

            <View
              style={
                styles.editorHeaderSpacer
              }
            />
          </View>

          <View
            style={
              styles.editorAvatarLarge
            }
          >
            <Text
              style={
                styles.editorAvatarText
              }
            >
              {name
                ? name
                    .trim()
                    .charAt(0)
                    .toUpperCase()
                : "?"}
            </Text>
          </View>

          <View
            style={
              styles.editorCard
            }
          >
            <Text
              style={
                styles.formLabel
              }
            >
              Name
            </Text>

            <TextInput
              style={
                styles.formInput
              }
              value={name}
              onChangeText={setName}
              placeholder="Mom / Dad / Friend"
              placeholderTextColor={
                COLORS.creamText
              }
            />

            <Text
              style={
                styles.formLabel
              }
            >
              Relationship
            </Text>

            <TextInput
              style={
                styles.formInput
              }
              value={relation}
              onChangeText={
                setRelation
              }
              placeholder="Mother / Father / Friend"
              placeholderTextColor={
                COLORS.creamText
              }
            />

            <Text
              style={
                styles.formLabel
              }
            >
              Phone Number
            </Text>

            <TextInput
              style={
                styles.formInput
              }
              value={phone}
              onChangeText={setPhone}
              placeholder="+91 9876543210"
              placeholderTextColor={
                COLORS.creamText
              }
              keyboardType="phone-pad"
            />

            <Pressable
              style={
                styles.primaryToggleRow
              }
              onPress={() =>
                setPrimary(
                  !primary
                )
              }
            >
              <View
                style={
                  styles.primaryToggleTextWrap
                }
              >
                <Text
                  style={
                    styles.primaryToggleTitle
                  }
                >
                  Set as Primary Contact
                </Text>

                <Text
                  style={
                    styles.primaryToggleSubtitle
                  }
                >
                  This contact is shown first during an emergency.
                </Text>
              </View>

              <View
                style={[
                  styles.switchTrack,
                  primary &&
                    styles.switchTrackActive,
                ]}
              >
                <View
                  style={[
                    styles.switchThumb,
                    primary &&
                      styles.switchThumbActive,
                  ]}
                />
              </View>
            </Pressable>

            <Pressable
              style={
                styles.saveButton
              }
              onPress={save}
            >
              <Text
                style={
                  styles.saveButtonText
                }
              >
                {contact
                  ? "Save Contact"
                  : "Add Contact"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function SOSEmergencyScreen({
  contacts,
  onContactsChange,
  profile,
  onBackHome,
  onExplore,
  onSOS,
  onProfile,
}: {
  contacts: EmergencyContact[];
  onContactsChange: (
    contacts: EmergencyContact[]
  ) => void;
  profile: UserProfile;
  onBackHome: () => void;
  onExplore: () => void;
  onSOS: () => void;
  onProfile: () => void;
}) {
  const [
    activeSOS,
    setActiveSOS,
  ] = useState(false);

  const [
    currentLocation,
    setCurrentLocation,
  ] = useState<Point | null>(
    null
  );

  const [
    locationStatus,
    setLocationStatus,
  ] = useState(
    "Location ready"
  );

  const [
    sentCount,
    setSentCount,
  ] = useState(0);

  const [
    sosSeconds,
    setSosSeconds,
  ] = useState(0);

  const locationSubscription =
    useRef<Location.LocationSubscription | null>(
      null
    );

  const alarmPlayer =
    useAudioPlayer(
      "https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg",
      {
        downloadFirst: true,
      }
    );

  const startSOS = async () => {
    if (!contacts.length) {
      Alert.alert(
        "Add emergency contacts",
        "Please add at least one emergency contact in Profile before activating SOS."
      );
      return;
    }

    const permission =
      await Location.requestForegroundPermissionsAsync();

    if (
      permission.status !==
      "granted"
    ) {
      Alert.alert(
        "Location permission needed",
        "Securia needs location access to prepare your emergency location."
      );
      return;
    }

    try {
      setLocationStatus(
        "Getting your current location…"
      );

      const position =
        await Location.getCurrentPositionAsync({
          accuracy:
            Location.Accuracy.High,
        });

      const point: Point = {
        latitude:
          position.coords.latitude,
        longitude:
          position.coords.longitude,
      };

      setCurrentLocation(point);
      setLocationStatus(
        "Live GPS tracking active"
      );
      setActiveSOS(true);
      setSosSeconds(0);
      setSentCount(0);

      try {
        alarmPlayer.loop = true;
        alarmPlayer.volume = 1;
        alarmPlayer.play();
      } catch {
        // The SOS state still works if audio cannot start.
      }

      Vibration.vibrate(
        [0, 700, 250, 700],
        true
      );

      locationSubscription.current =
        await Location.watchPositionAsync(
          {
            accuracy:
              Location.Accuracy.High,
            timeInterval: 2000,
            distanceInterval: 5,
          },
          (location) => {
            const nextPoint: Point = {
              latitude:
                location.coords.latitude,
              longitude:
                location.coords.longitude,
            };

            setCurrentLocation(
              nextPoint
            );
            setLocationStatus(
              "Live GPS tracking active"
            );
          }
        );

      const locationUrl =
        `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;

      const firstMessage =
        `Securia emergency alert${profile.name ? ` from ${profile.name}` : ""}. Current location: ${locationUrl}`;

      const available =
        await SMS.isAvailableAsync();

      if (available) {
        const numbers =
          contacts.map(
            (contact) =>
              contact.phone
          );

        const result =
          await SMS.sendSMSAsync(
            numbers,
            firstMessage
          );

        if (
          result.result !==
          "cancelled"
        ) {
          setSentCount(
            numbers.length
          );
        } else {
          setSentCount(0);
        }
      } else {
        Alert.alert(
          "SOS active",
          "SMS is not available on this device. The SOS screen and live GPS tracking are still active."
        );
      }
    } catch {
      stopSOS();
      Alert.alert(
        "SOS could not start",
        "Securia could not access the phone location. Please check Location Services."
      );
    }
  };

  const stopSOS = () => {
    if (
      locationSubscription.current
    ) {
      locationSubscription.current.remove();
      locationSubscription.current =
        null;
    }

    try {
      alarmPlayer.pause();
    } catch {}

    Vibration.cancel();

    setActiveSOS(false);
    setSosSeconds(0);
    setLocationStatus(
      "Location ready"
    );
  };

  useEffect(() => {
    if (!activeSOS) return;

    const timer =
      setInterval(() => {
        setSosSeconds(
          (seconds) =>
            seconds + 1
        );
      }, 1000);

    return () =>
      clearInterval(timer);
  }, [activeSOS]);

  useEffect(() => {
    return () => {
      if (
        locationSubscription.current
      ) {
        locationSubscription.current.remove();
      }

      try {
        alarmPlayer.pause();
      } catch {}

      Vibration.cancel();
    };
  }, []);

  const formatSeconds = (
    value: number
  ) => {
    const minutes =
      Math.floor(
        value / 60
      )
        .toString()
        .padStart(2, "0");

    const seconds =
      (value % 60)
        .toString()
        .padStart(2, "0");

    return `${minutes}:${seconds}`;
  };

  const resendLocation = async () => {
    if (!currentLocation) {
      Alert.alert(
        "Location unavailable",
        "Wait for the phone GPS position."
      );
      return;
    }

    const available =
      await SMS.isAvailableAsync();

    if (!available) {
      Alert.alert(
        "SMS unavailable",
        "The phone cannot open the SMS service right now."
      );
      return;
    }

    const locationUrl =
      `https://www.google.com/maps?q=${currentLocation.latitude},${currentLocation.longitude}`;

    const message =
      `Securia live location update${profile.name ? ` from ${profile.name}` : ""}: ${locationUrl}`;

    const result =
      await SMS.sendSMSAsync(
        contacts.map(
          (contact) =>
            contact.phone
        ),
        message
      );

    if (
      result.result !==
      "cancelled"
    ) {
      setSentCount(
        contacts.length
      );
    }
  };

  if (activeSOS) {
    return (
      <SafeAreaView
        style={
          styles.safeArea
        }
      >
        <View
          style={
            styles.sosScreen
          }
        >
          <ScrollView
            showsVerticalScrollIndicator={
              false
            }
            contentContainerStyle={
              styles.sosScroll
            }
          >
            <View
              style={
                styles.sosHeader
              }
            >
              <Pressable
                onPress={
                  stopSOS
                }
                style={
                  styles.sosBackButton
                }
              >
                <Text
                  style={
                    styles.sosBackText
                  }
                >
                  ‹
                </Text>
              </Pressable>

              <Text
                style={
                  styles.sosHeaderTitle
                }
              >
                Active SOS
              </Text>

              <View
                style={
                  styles.sosHeaderSpacer
                }
              />
            </View>

            <View
              style={
                styles.activeSOSBanner
              }
            >
              <Text
                style={
                  styles.activeSOSIcon
                }
              >
                🚨
              </Text>

              <View
                style={
                  styles.activeSOSTextWrap
                }
              >
                <Text
                  style={
                    styles.activeSOSTitle
                  }
                >
                  SOS Activated
                </Text>

                <Text
                  style={
                    styles.activeSOSSubtitle
                  }
                >
                  {formatSeconds(
                    sosSeconds
                  )}
                </Text>
              </View>
            </View>

            <View
              style={
                styles.sosStatusCard
              }
            >
              <SOSStatusRow
                icon="📍"
                title="Live location"
                value={
                  locationStatus
                }
                ok={
                  !!currentLocation
                }
              />

              <SOSStatusRow
                icon="👥"
                title="Emergency contacts"
                value={
                  sentCount > 0
                    ? `${sentCount}/${contacts.length} SMS composer opened`
                    : `0/${contacts.length} contacts notified yet`
                }
                ok={
                  sentCount > 0
                }
              />

              <SOSStatusRow
                icon="🔊"
                title="Alarm"
                value="Ringing on this device"
                ok
              />
            </View>

            {currentLocation && (
              <View
                style={
                  styles.locationCard
                }
              >
                <Text
                  style={
                    styles.locationCardTitle
                  }
                >
                  Current GPS position
                </Text>

                <Text
                  style={
                    styles.locationCardText
                  }
                >
                  {currentLocation.latitude.toFixed(
                    6
                  )},{" "}
                  {currentLocation.longitude.toFixed(
                    6
                  )}
                </Text>

                <Pressable
                  style={
                    styles.updateLocationButton
                  }
                  onPress={
                    resendLocation
                  }
                >
                  <Text
                    style={
                      styles.updateLocationText
                    }
                  >
                    Send Updated Location
                  </Text>
                </Pressable>
              </View>
            )}

            <Text
              style={
                styles.sosSectionTitle
              }
            >
              Contacts Notified
            </Text>

            {contacts.map(
              (contact) => (
                <View
                  key={
                    contact.id
                  }
                  style={
                    styles.sosContactRow
                  }
                >
                  <View
                    style={
                      styles.sosContactAvatar
                    }
                  >
                    <Text
                      style={
                        styles.sosContactAvatarText
                      }
                    >
                      {contact.name
                        .charAt(0)
                        .toUpperCase()}
                    </Text>
                  </View>

                  <View
                    style={
                      styles.sosContactInfo
                    }
                  >
                    <Text
                      style={
                        styles.sosContactName
                      }
                    >
                      {contact.name}
                    </Text>

                    <Text
                      style={
                        styles.sosContactPhone
                      }
                    >
                      {contact.phone}
                    </Text>
                  </View>

                  <Text
                    style={[
                      styles.sosSentText,
                      sentCount > 0 &&
                        styles.sosSentTextActive,
                    ]}
                  >
                    {sentCount > 0
                      ? "✓ Ready"
                      : "Pending"}
                  </Text>
                </View>
              )
            )}

            <Pressable
              style={
                styles.stopSOSButton
              }
              onPress={
                stopSOS
              }
            >
              <Text
                style={
                  styles.stopSOSButtonText
                }
              >
                ■ Stop SOS
              </Text>
            </Pressable>
          </ScrollView>

          <BottomNav
            active="SOS"
            onHome={() => { stopSOS(); onBackHome(); }}
            onExplore={() => { stopSOS(); onExplore(); }}
            onSOS={onSOS}
            onProfile={() => { stopSOS(); onProfile(); }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={
        styles.safeArea
      }
    >
      <View
        style={
          styles.sosScreen
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.sosScroll
          }
        >
          <View
            style={
              styles.sosHeader
            }
          >
            <View>
              <Text
                style={
                  styles.sosEyebrow
                }
              >
                SECURIA
              </Text>

              <Text
                style={
                  styles.sosPageTitle
                }
              >
                SOS Emergency
              </Text>
            </View>
          </View>

          <Text
            style={
              styles.sosIntro
            }
          >
            Get help quickly. Share your current location with your trusted contacts.
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.sosMainButton,
              pressed &&
                styles.sosMainButtonPressed,
            ]}
            onPress={
              startSOS
            }
          >
            <View
              style={
                styles.sosMainButtonInner
              }
            >
              <Text
                style={
                  styles.sosBell
                }
              >
                🔔
              </Text>

              <Text
                style={
                  styles.sosMainButtonText
                }
              >
                SOS
              </Text>

              <Text
                style={
                  styles.sosHoldText
                }
              >
                TAP TO ACTIVATE
              </Text>
            </View>
          </Pressable>

          <View
            style={
              styles.sosFeatureCard
            }
          >
            <SOSFeatureRow
              icon="📍"
              title="Send your location"
              text="Creates a real Maps location link from phone GPS."
            />

            <SOSFeatureRow
              icon="👥"
              title="Alert your contacts"
              text="Opens the phone SMS service for your saved contacts."
            />

            <SOSFeatureRow
              icon="🔊"
              title="Activate an alarm"
              text="Starts the Securia alarm and vibration on the device."
            />

            <SOSFeatureRow
              icon="📡"
              title="Keep GPS tracking"
              text="Securia continues receiving foreground location updates while SOS is active."
            />
          </View>

          <View
            style={
              styles.sosContactsHeader
            }
          >
            <Text
              style={
                styles.sosSectionTitle
              }
            >
              Emergency Contacts
            </Text>

            <Text
              style={
                styles.sosContactsCount
              }
            >
              {contacts.length}/5
            </Text>
          </View>

          {contacts.length === 0 ? (
            <View
              style={
                styles.emptySOSContacts
              }
            >
              <Text
                style={
                  styles.emptySOSIcon
                }
              >
                👥
              </Text>

              <Text
                style={
                  styles.emptySOSTitle
                }
              >
                No contacts added
              </Text>

              <Text
                style={
                  styles.emptySOSText
                }
              >
                Open Profile and add trusted emergency contacts first.
              </Text>
            </View>
          ) : (
            contacts.map(
              (contact) => (
                <View
                  key={
                    contact.id
                  }
                  style={
                    styles.sosContactPreview
                  }
                >
                  <View
                    style={
                      styles.sosContactAvatar
                    }
                  >
                    <Text
                      style={
                        styles.sosContactAvatarText
                      }
                    >
                      {contact.name
                        .charAt(0)
                        .toUpperCase()}
                    </Text>
                  </View>

                  <View
                    style={
                      styles.sosContactInfo
                    }
                  >
                    <Text
                      style={
                        styles.sosContactName
                      }
                    >
                      {contact.name}
                    </Text>

                    <Text
                      style={
                        styles.sosContactPhone
                      }
                    >
                      {contact.phone}
                    </Text>
                  </View>

                  {contact.primary && (
                    <Text
                      style={
                        styles.primaryMini
                      }
                    >
                      PRIMARY
                    </Text>
                  )}
                </View>
              )
            )
          )}

          <View
            style={
              styles.sosNote
            }
          >
            <Text
              style={
                styles.sosNoteText
              }
            >
              Test SOS only in a safe environment. SMS availability and phone permissions are controlled by the device.
            </Text>
          </View>
        </ScrollView>

        <BottomNav
          active="SOS"
          onHome={onBackHome}
          onExplore={onExplore}
          onSOS={onSOS}
          onProfile={onProfile}
        />
      </View>
    </SafeAreaView>
  );
}

function SOSFeatureRow({
  icon,
  title,
  text,
}: {
  icon: string;
  title: string;
  text: string;
}) {
  return (
    <View
      style={
        styles.sosFeatureRow
      }
    >
      <Text
        style={
          styles.sosFeatureIcon
        }
      >
        {icon}
      </Text>

      <View
        style={
          styles.sosFeatureTextWrap
        }
      >
        <Text
          style={
            styles.sosFeatureTitle
          }
        >
          {title}
        </Text>

        <Text
          style={
            styles.sosFeatureText
          }
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

function SOSStatusRow({
  icon,
  title,
  value,
  ok,
}: {
  icon: string;
  title: string;
  value: string;
  ok: boolean;
}) {
  return (
    <View
      style={
        styles.sosStatusRow
      }
    >
      <Text
        style={
          styles.sosStatusIcon
        }
      >
        {icon}
      </Text>

      <View
        style={
          styles.sosStatusTextWrap
        }
      >
        <Text
          style={
            styles.sosStatusTitle
          }
        >
          {title}
        </Text>

        <Text
          style={
            styles.sosStatusValue
          }
        >
          {value}
        </Text>
      </View>

      <Text
        style={[
          styles.sosStatusCheck,
          ok &&
            styles.sosStatusCheckActive,
        ]}
      >
        {ok ? "✓" : "!"}
      </Text>
    </View>
  );
}

/* ============================================================
   BOTTOM NAVIGATION
============================================================ */

function BottomNav({
  active,
  onHome,
  onExplore,
  onSOS,
  onProfile,
}: {
  active:
    | "Home"
    | "Explore"
    | "SOS"
    | "Profile";
  onHome: () => void;
  onExplore: () => void;
  onSOS: () => void;
  onProfile: () => void;
}) {
  const LUMI_WELCOME =
    "Hi! I’m Lumi 👋🏻\nYour smart safety companion.\n\nI’m here to help you find safer routes, understand the safety conditions around you, and stay informed throughout your journey.\n\nLet’s get you there safely. 🛡️✨";

  const LUMI_OUTRO =
    "It was lovely chatting with you! Stay safe, take care, and have a wonderful journey. 🛡️💛";

  const [showLumiChat, setShowLumiChat] = useState(false);
  const [lumiMinimized, setLumiMinimized] = useState(false);
  const [message, setMessage] = useState("");
  const lumiSendingRef = useRef(false);
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      text: LUMI_WELCOME,
      fromLumi: true,
    },
  ]);

  const openOrEnlargeLumi = () => {
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        text: LUMI_WELCOME,
        fromLumi: true,
      },
    ]);
    setMessage("");
    setLumiMinimized(false);
    setShowLumiChat(true);
  };

  const closeLumi = () => {
    setShowLumiChat(false);
    setLumiMinimized(false);
  };

  const sendLumiMessage = async (preset?: string) => {
    const text = (preset ?? message).trim();
    if (!text || lumiSendingRef.current) return;

    // Prevent accidental duplicate requests while a reply is pending.
    lumiSendingRef.current = true;

    setMessages((current) => [
      ...current,
      { id: `${Date.now()}-user`, text, fromLumi: false },
    ]);
    setMessage("");

    try {
      const response = await fetch(
        "http://192.168.0.3:3000/api/lumi",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : "Lumi is temporarily unavailable. Please try again later."
        );
      }

      if (typeof data?.reply !== "string" || !data.reply.trim()) {
        throw new Error("Lumi returned an empty response. Please try again later.");
      }

      setMessages((current) => [
        ...current,
        { id: `${Date.now()}-lumi`, text: data.reply.trim(), fromLumi: true },
      ]);
    } catch (error) {
      console.error("Lumi chat request failed:", error);
      const detail =
        error instanceof Error ? error.message : "Unable to reach the Lumi server.";

      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-lumi-error`,
          text: `Sorry, I couldn't connect to Lumi. ${detail}`,
          fromLumi: true,
        },
      ]);
    } finally {
      lumiSendingRef.current = false;
    }
  };

  return (
    <View style={styles.bottomNavWrapper}>
      {showLumiChat && (
        <View style={styles.lumiChatBubble}>
          <BlurView
            intensity={48}
            tint="dark"
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.lumiGlassTint} />

          {!lumiMinimized ? (
          <>
          <View style={styles.lumiChatHeader}>
            <View style={styles.lumiChatIdentity}>
              <View style={styles.lumiChatAvatarRing}>
                <Image source={LUMI_ICON} style={styles.lumiChatAvatar} />
              </View>
              <View style={styles.lumiChatTitleBox}>
                <Text style={styles.lumiChatTitle}>Lumi</Text>
                <Text style={styles.lumiChatOnline}>● Online • Securia AI companion</Text>
              </View>
            </View>

            <View style={styles.lumiHeaderActions}>
              <Pressable
                style={styles.lumiChatMinimize}
                onPress={() => setLumiMinimized(true)}
                accessibilityLabel="Minimize Lumi"
              >
                <Text style={styles.lumiChatMinimizeText}>—</Text>
              </Pressable>

              <Pressable
                style={styles.lumiChatClose}
                onPress={closeLumi}
                accessibilityLabel="Close Lumi"
              >
                <Text style={styles.lumiChatCloseText}>×</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.lumiChatDivider} />

          <ScrollView
            style={styles.lumiMessages}
            contentContainerStyle={styles.lumiMessagesContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {messages.slice(-5).map((item) => (
              <View
                key={item.id}
                style={[
                  styles.lumiMessageRow,
                  !item.fromLumi && styles.lumiUserMessageRow,
                ]}
              >
                {item.fromLumi && (
                  <Image source={LUMI_ICON} style={styles.lumiTinyAvatar} />
                )}
                <View
                  style={[
                    styles.lumiMessageBubble,
                    item.fromLumi
                      ? styles.lumiBotBubble
                      : styles.lumiUserBubble,
                  ]}
                >
                  <Text style={[styles.lumiMessageText, !item.fromLumi && styles.lumiUserBubbleText]}>{item.text}</Text>
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={styles.lumiQuickRow}>
            <Pressable
              style={styles.lumiQuickChip}
              onPress={() => sendLumiMessage("How do I find a safer route?")}
            >
              <Text style={styles.lumiQuickChipText}>Safer route</Text>
            </Pressable>
            <Pressable
              style={styles.lumiQuickChip}
              onPress={() => sendLumiMessage("What can I do in an emergency?")}
            >
              <Text style={styles.lumiQuickChipText}>SOS help</Text>
            </Pressable>
          </View>

          <View style={styles.lumiInputRow}>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="Ask Lumi anything..."
              placeholderTextColor="#B79CA3"
              style={styles.lumiInput}
              returnKeyType="send"
              onSubmitEditing={() => sendLumiMessage()}
            />
            <Pressable
              style={styles.lumiSendButton}
              onPress={() => sendLumiMessage()}
            >
              <Text style={styles.lumiSendText}>➤</Text>
            </Pressable>
          </View>
          </>
          ) : (
            <Pressable
              style={styles.lumiMinimizedBar}
              onPress={openOrEnlargeLumi}
              accessibilityLabel="Expand Lumi"
            >
              <View style={styles.lumiMinimizedIdentity}>
                <View style={styles.lumiMinimizedIconRing}>
                  <Image source={LUMI_ICON} style={styles.lumiMinimizedIcon} />
                </View>
                <View>
                  <Text style={styles.lumiMinimizedTitle}>Lumi</Text>
                  <Text style={styles.lumiMinimizedSubtitle}>Tap to continue chatting</Text>
                </View>
              </View>
              <Text style={styles.lumiMinimizedChevron}>⌃</Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.bottomNav}>
        <Pressable
          style={[
            styles.navItem,
            active === "Home" && styles.navItemExploreActive,
          ]}
          onPress={onHome}
        >
          <Text style={styles.homeIcon}>⌂</Text>
          <Text style={[styles.navText, active === "Home" && styles.activeNavText]}>
            Home
          </Text>
        </Pressable>

        <Pressable
          style={[
            styles.navItem,
            active === "Explore" && styles.navItemExploreActive,
          ]}
          onPress={onExplore}
        >
          <Text style={styles.exploreIcon}>▣</Text>
          <Text style={[styles.navText, active === "Explore" && styles.activeNavText]}>
            Explore
          </Text>
        </Pressable>

        <Pressable
          style={[
            styles.navItem,
            styles.sosNavItem,
            active === "SOS" && styles.sosNavItemActive,
          ]}
          onPress={onSOS}
        >
          <Text style={styles.sosNavIcon}>SOS</Text>
          <Text style={[styles.navText, styles.sosNavText, active === "SOS" && styles.sosNavTextActive]}>
            Emergency
          </Text>
        </Pressable>

        <Pressable
          style={[
            styles.navItem,
            active === "Profile" && styles.navItemExploreActive,
          ]}
          onPress={onProfile}
        >
          <Text style={styles.profileNavIcon}>●</Text>
          <Text style={[styles.navText, active === "Profile" && styles.activeNavText]}>
            Profile
          </Text>
        </Pressable>

        <Pressable
          style={[styles.navItem, styles.lumiNavItem]}
          onPress={() =>
            showLumiChat && !lumiMinimized
              ? closeLumi()
              : openOrEnlargeLumi()
          }
        >
          <View style={styles.lumiNavIconRing}>
            <Image source={LUMI_ICON} style={styles.lumiNavIcon} />
          </View>
          <Text style={styles.lumiNavText} numberOfLines={1} adjustsFontSizeToFit>
            Meet Lumi
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ============================================================
   STYLES
============================================================ */

const styles =
  StyleSheet.create({
    /* ========================================================
       GENERAL
    ======================================================== */

    safeArea: {
      flex: 1,
      backgroundColor:
        COLORS.background,
    },

    container: {
      flex: 1,
      backgroundColor:
        COLORS.background,
      paddingHorizontal: 22,
      paddingTop: 45,
    },

    homeScroll: {
      paddingBottom: 110,
    },

    /* ========================================================
       HEADER
    ======================================================== */

    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent:
        "space-between",
      marginBottom: 28,
    },

    headerText: {
      flex: 1,
    },

    logoText: {
      color: COLORS.gold,
      fontSize: 43,
      fontWeight: "800",
      letterSpacing: -1.5,
    },

    tagline: {
      color:
        COLORS.goldLight,
      fontSize: 17,
      marginTop: 2,
    },

    logoCircle: {
      width: 84,
      height: 84,
      borderRadius: 42,
      borderWidth: 3,
      borderColor:
        "#B99755",
      alignItems: "center",
      justifyContent: "center",
      marginLeft: 12,
    },

    logoImage: {
      width: 63,
      height: 63,
      borderRadius: 31,
    },

    /* ========================================================
       HOME CARD
    ======================================================== */

    mainCard: {
      backgroundColor:
        COLORS.card,
      borderWidth: 1.2,
      borderColor:
        COLORS.cardBorder,
      borderRadius: 34,
      paddingHorizontal: 24,
      paddingTop: 31,
      paddingBottom: 22,
    },

    heading: {
      color: COLORS.gold,
      fontSize: 32,
      lineHeight: 39,
      fontWeight: "800",
    },

    description: {
      color:
        COLORS.goldLight,
      fontSize: 17,
      marginTop: 8,
      marginBottom: 21,
    },

    inputBox: {
      height: 70,
      backgroundColor:
        COLORS.cream,
      borderRadius: 21,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 19,
      marginBottom: 17,
    },

    pin: {
      fontSize: 22,
      width: 35,
      textAlign: "center",
    },

    divider: {
      width: 1,
      height: 29,
      backgroundColor:
        "#D8CBCD",
      marginHorizontal: 10,
    },

    input: {
      flex: 1,
      color:
        COLORS.darkText,
      fontSize: 16,
      fontWeight: "500",
    },

    startLocationLabel: {
      color: COLORS.goldLight,
      fontSize: 15,
      fontWeight: "700",
      marginBottom: 9,
      marginTop: 2,
    },

    currentLocationButton: {
      minHeight: 70,
      borderRadius: 21,
      borderWidth: 1.3,
      borderColor: COLORS.goldBorder,
      backgroundColor: "#421018",
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      marginBottom: 12,
    },

    currentLocationButtonActive: {
      borderColor: COLORS.green,
      backgroundColor: COLORS.greenBg,
    },

    currentLocationIcon: {
      fontSize: 24,
      width: 38,
      textAlign: "center",
      marginRight: 9,
    },

    currentLocationTextWrap: {
      flex: 1,
    },

    currentLocationTitle: {
      color: COLORS.cream,
      fontSize: 16,
      fontWeight: "800",
    },

    currentLocationSubtitle: {
      color: COLORS.goldLight,
      fontSize: 12,
      marginTop: 3,
    },

    currentLocationCheck: {
      color: COLORS.green,
      fontSize: 26,
      fontWeight: "800",
      marginLeft: 8,
    },

    orDividerRow: {
      flexDirection: "row",
      alignItems: "center",
      marginVertical: 5,
    },

    orLine: {
      flex: 1,
      height: 1,
      backgroundColor: COLORS.cardBorder,
    },

    orText: {
      color: COLORS.creamText,
      fontSize: 12,
      fontWeight: "800",
      marginHorizontal: 12,
    },

    manualLocationButton: {
      minHeight: 54,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      backgroundColor: "#30070B",
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      marginBottom: 12,
    },

    manualLocationButtonActive: {
      borderColor: COLORS.goldBorder,
    },

    manualLocationIcon: {
      fontSize: 20,
      width: 36,
      textAlign: "center",
      marginRight: 8,
    },

    manualLocationText: {
      flex: 1,
      color: COLORS.goldLight,
      fontSize: 14,
      fontWeight: "700",
    },

    selectedLocationBox: {
      minHeight: 62,
      borderRadius: 19,
      backgroundColor: COLORS.greenBg,
      borderWidth: 1,
      borderColor: COLORS.green,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      marginBottom: 17,
    },

    selectedLocationIcon: {
      color: COLORS.green,
      fontSize: 23,
      fontWeight: "900",
      width: 36,
      textAlign: "center",
      marginRight: 8,
    },

    selectedLocationTextWrap: {
      flex: 1,
    },

    selectedLocationTitle: {
      color: COLORS.cream,
      fontSize: 15,
      fontWeight: "800",
    },

    selectedLocationSubtitle: {
      color: COLORS.goldLight,
      fontSize: 11,
      marginTop: 3,
      lineHeight: 15,
    },

        routeButton: {
      height: 68,
      backgroundColor:
        "#F3C96D",
      borderRadius: 22,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },

    routeButtonText: {
      color: COLORS.card,
      fontSize: 19,
      fontWeight: "800",
    },

    arrow: {
      color: COLORS.card,
      fontSize: 29,
      fontWeight: "700",
      marginLeft: 12,
    },

    pressed: {
      opacity: 0.75,
    },

    routePressed: {
      opacity: 0.82,
      transform: [
        {
          scale: 0.99,
        },
      ],
    },

    /* ========================================================
       QUICK ACCESS
    ======================================================== */

    quickAccess: {
      marginTop: 26,
    },

    sectionTitle: {
      color: COLORS.gold,
      fontSize: 19,
      fontWeight: "800",
      marginTop: 22,
      marginBottom: 12,
    },

    sectionTitleNoMargin: {
      color: COLORS.gold,
      fontSize: 19,
      fontWeight: "800",
    },

    quickRow: {
      flexDirection: "row",
      gap: 8,
    },

    quickButton: {
      flex: 1,
      minHeight: 80,
      borderRadius: 18,
      borderWidth: 1,
      borderColor:
        COLORS.cardBorder,
      backgroundColor:
        COLORS.card,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 3,
    },

    quickIcon: {
      color: COLORS.gold,
      fontSize: 20,
      marginBottom: 5,
    },

    quickText: {
      color: COLORS.cream,
      fontSize: 10,
      textAlign: "center",
    },

    /* ========================================================
       LUMI TASKBAR + CHATBOT
    ======================================================== */

    bottomNavWrapper: {
      alignItems: "center",
      justifyContent: "flex-end",
      position: "relative",
      width: "100%",
      zIndex: 500,
      elevation: 50,
    },

    lumiNavItem: {
      flex: 1,
      minWidth: 0,
    },

    lumiNavIconRing: {
      width: 31,
      height: 31,
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: "#B99755",
      backgroundColor: "#5A1825",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 2,
      overflow: "hidden",
    },

    lumiNavIcon: {
      width: 31,
      height: 31,
      borderRadius: 16,
    },

    lumiNavText: {
      color: COLORS.cream,
      fontSize: 8,
      fontWeight: "800",
      textAlign: "center",
      includeFontPadding: false,
    },

    lumiChatBubble: {
      position: "absolute",
      right: 7,
      bottom: 92,
      width: 344,
      maxWidth: "91%",
      height: 445,
      borderRadius: 26,
      borderWidth: 1.2,
      borderColor: "rgba(245, 142, 177, 0.62)",
      backgroundColor: "rgba(42, 0, 10, 0.76)",
      zIndex: 300,
      elevation: 24,
      shadowColor: "#F06B9A",
      shadowOpacity: 0.28,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 8 },
      overflow: "hidden",
    },

    lumiGlassTint: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(67, 8, 25, 0.28)",
    },

    lumiChatHeader: {
      minHeight: 72,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: "rgba(75, 10, 31, 0.38)",
    },

    lumiChatIdentity: {
      flexDirection: "row",
      alignItems: "center",
      flex: 1,
    },

    lumiChatAvatarRing: {
      width: 50,
      height: 50,
      borderRadius: 25,
      borderWidth: 1.5,
      borderColor: COLORS.gold,
      overflow: "hidden",
      backgroundColor: "#5A1825",
    },

    lumiChatAvatar: {
      width: 50,
      height: 50,
    },

    lumiChatTitleBox: {
      marginLeft: 10,
      flex: 1,
    },

    lumiChatTitle: {
      color: COLORS.cream,
      fontSize: 18,
      fontWeight: "900",
    },

    lumiChatOnline: {
      color: "#72D69A",
      fontSize: 9,
      marginTop: 3,
    },

    lumiHeaderActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      marginLeft: 8,
    },

    lumiChatMinimize: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "rgba(245, 142, 177, 0.48)",
      backgroundColor: "rgba(86, 12, 35, 0.58)",
    },

    lumiChatMinimizeText: {
      color: COLORS.cream,
      fontSize: 20,
      lineHeight: 20,
      fontWeight: "800",
      marginTop: -4,
    },

    lumiChatClose: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "#9C2947",
      backgroundColor: "#4A0A17",
    },

    lumiChatCloseText: {
      color: COLORS.cream,
      fontSize: 22,
      lineHeight: 24,
      fontWeight: "700",
    },

    lumiChatDivider: {
      height: 1,
      backgroundColor: "rgba(245, 142, 177, 0.22)",
    },

    lumiMessages: {
      flex: 1,
    },

    lumiMessagesContent: {
      padding: 12,
      paddingBottom: 8,
    },

    lumiMessageRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      marginBottom: 10,
      paddingRight: 20,
    },

    lumiUserMessageRow: {
      justifyContent: "flex-end",
      paddingRight: 0,
      paddingLeft: 35,
    },

    lumiTinyAvatar: {
      width: 25,
      height: 25,
      borderRadius: 13,
      marginRight: 6,
      borderWidth: 1,
      borderColor: COLORS.gold,
    },

    lumiMessageBubble: {
      maxWidth: "82%",
      paddingHorizontal: 11,
      paddingVertical: 9,
      borderRadius: 15,
    },

    lumiBotBubble: {
      backgroundColor: "#4A0D1B",
      borderTopLeftRadius: 4,
      borderWidth: 1,
      borderColor: "#67152B",
    },

    lumiUserBubble: {
      backgroundColor: "#F1C963",
      borderTopRightRadius: 4,
    },

    lumiMessageText: {
      color: COLORS.cream,
      fontSize: 11,
      lineHeight: 16,
    },

    lumiUserBubbleText: {
      color: "#3A0710",
    },

    lumiQuickRow: {
      flexDirection: "row",
      paddingHorizontal: 10,
      paddingBottom: 8,
      gap: 6,
    },

    lumiQuickChip: {
      borderWidth: 1,
      borderColor: "#9C2947",
      backgroundColor: "#350812",
      borderRadius: 15,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },

    lumiQuickChipText: {
      color: COLORS.gold,
      fontSize: 9,
      fontWeight: "800",
    },

    lumiInputRow: {
      flexDirection: "row",
      alignItems: "center",
      padding: 9,
      borderTopWidth: 1,
      borderTopColor: "#5E1729",
      backgroundColor: "rgba(54, 6, 20, 0.48)",
    },

    lumiInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 70,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: "#7D213A",
      backgroundColor: "#180208",
      color: COLORS.cream,
      paddingHorizontal: 14,
      paddingVertical: 9,
      fontSize: 11,
    },

    lumiSendButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      marginLeft: 7,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: COLORS.gold,
    },

    lumiSendText: {
      color: "#3A0710",
      fontSize: 19,
      fontWeight: "900",
      marginLeft: 2,
    },

    lumiMinimizedBar: {
      minHeight: 76,
      paddingHorizontal: 13,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: "rgba(63, 7, 25, 0.62)",
    },

    lumiMinimizedIdentity: {
      flexDirection: "row",
      alignItems: "center",
      flex: 1,
    },

    lumiMinimizedIconRing: {
      width: 46,
      height: 46,
      borderRadius: 23,
      borderWidth: 1.5,
      borderColor: COLORS.gold,
      backgroundColor: "rgba(90, 24, 37, 0.8)",
      overflow: "hidden",
      marginRight: 10,
    },

    lumiMinimizedIcon: {
      width: 46,
      height: 46,
    },

    lumiMinimizedTitle: {
      color: COLORS.cream,
      fontSize: 16,
      fontWeight: "900",
    },

    lumiMinimizedSubtitle: {
      color: "#D4BFC5",
      fontSize: 9,
      marginTop: 2,
    },

    lumiMinimizedChevron: {
      color: COLORS.gold,
      fontSize: 23,
      fontWeight: "900",
      paddingHorizontal: 8,
    },

    /* ========================================================
       BOTTOM NAV
    ======================================================== */

    bottomNav: {
      height: 70,
      width: "92%",
      maxWidth: 370,
      borderRadius: 34,
      borderWidth: 1,
      borderColor:
        COLORS.cardBorder,
      backgroundColor:
        "#210004",
      alignSelf: "center",
      marginBottom: 12,
      flexDirection: "row",
      alignItems: "center",
      padding: 4,
      zIndex: 600,
      elevation: 60,
    },

    navItem: {
      flex: 1,
      height: 60,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 28,
    },

    sosNavItem: {
      backgroundColor: "#3A0710",
      borderWidth: 1,
      borderColor: "#721524",
    },

    sosNavItemActive: {
      backgroundColor: COLORS.red,
      borderColor: "#FF8990",
    },

    sosNavIcon: {
      color: COLORS.red,
      fontSize: 13,
      fontWeight: "900",
      letterSpacing: 1,
      marginBottom: 2,
    },

    sosNavText: {
      color: "#FFB1B6",
      fontSize: 9,
    },

    sosNavTextActive: {
      color: COLORS.white,
    },

    profileNavIcon: {
      color: COLORS.cream,
      fontSize: 18,
      lineHeight: 18,
      marginBottom: 2,
    },

    navItemExploreActive: {
      backgroundColor:
        "#50000C",
    },

    homeIcon: {
      color: COLORS.gold,
      fontSize: 24,
      lineHeight: 24,
      marginBottom: 1,
    },

    exploreIcon: {
      color: COLORS.cream,
      fontSize: 21,
      lineHeight: 22,
      marginBottom: 2,
    },

    activeNavText: {
      color: COLORS.gold,
      fontSize: 12,
      fontWeight: "600",
    },

    navText: {
      color: COLORS.cream,
      fontSize: 12,
      fontWeight: "500",
    },

    /* ========================================================
       REPORT INCIDENT
    ======================================================== */

    reportScroll: {
      paddingHorizontal: 22,
      paddingTop: 44,
      paddingBottom: 40,
    },

    reportIntro: {
      color: COLORS.creamText,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 18,
    },

    reportCard: {
      backgroundColor: COLORS.cream,
      borderRadius: 26,
      padding: 20,
    },

    reportLocationButton: {
      minHeight: 62,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: "#DCCBCD",
      backgroundColor: "#FFF8F9",
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
    },

    reportLocationActive: {
      borderColor: "#72A85C",
      backgroundColor: "#F0F7EC",
    },

    reportLocationIcon: {
      fontSize: 21,
      width: 34,
      textAlign: "center",
    },

    reportLocationTextWrap: {
      flex: 1,
      marginLeft: 8,
    },

    reportLocationTitle: {
      color: COLORS.darkText,
      fontSize: 13,
      fontWeight: "800",
    },

    reportLocationSubtitle: {
      color: COLORS.creamText,
      fontSize: 10,
      marginTop: 3,
    },

    incidentTypeGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },

    incidentTypeButton: {
      borderWidth: 1,
      borderColor: "#DCCBCD",
      backgroundColor: "#FFF8F9",
      borderRadius: 13,
      paddingHorizontal: 11,
      paddingVertical: 10,
    },

    incidentTypeButtonActive: {
      backgroundColor: "#5A0712",
      borderColor: COLORS.goldBorder,
    },

    incidentTypeText: {
      color: COLORS.darkText,
      fontSize: 11,
      fontWeight: "600",
    },

    incidentTypeTextActive: {
      color: COLORS.gold,
    },

    reportDescriptionInput: {
      minHeight: 125,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: "#DCCBCD",
      backgroundColor: "#FFF8F9",
      color: COLORS.darkText,
      paddingHorizontal: 14,
      paddingTop: 13,
      fontSize: 13,
    },

    reportTimeRow: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 14,
    },

    reportTimeIcon: {
      fontSize: 16,
      marginRight: 7,
    },

    reportTimeText: {
      color: COLORS.creamText,
      fontSize: 10,
      flex: 1,
    },

    reportSubmitButton: {
      minHeight: 52,
      borderRadius: 15,
      backgroundColor: COLORS.background,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 20,
    },

    reportSubmitText: {
      color: COLORS.gold,
      fontSize: 14,
      fontWeight: "800",
    },

    reportSubmitArrow: {
      color: COLORS.gold,
      fontSize: 20,
      marginLeft: 9,
    },

    reportSuccessScreen: {
      flex: 1,
      backgroundColor: COLORS.background,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 30,
    },

    reportSuccessIcon: {
      width: 86,
      height: 86,
      borderRadius: 43,
      backgroundColor: COLORS.greenBg,
      borderWidth: 2,
      borderColor: COLORS.green,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 20,
    },

    reportSuccessIconText: {
      color: COLORS.green,
      fontSize: 43,
      fontWeight: "900",
    },

    reportSuccessTitle: {
      color: COLORS.gold,
      fontSize: 28,
      fontWeight: "900",
      textAlign: "center",
    },

    reportSuccessText: {
      color: COLORS.creamText,
      fontSize: 13,
      lineHeight: 20,
      textAlign: "center",
      marginTop: 12,
    },

    reportDoneButton: {
      minHeight: 52,
      borderRadius: 15,
      backgroundColor: COLORS.card,
      borderWidth: 1,
      borderColor: COLORS.goldBorder,
      paddingHorizontal: 28,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 24,
    },

    reportDoneButtonText: {
      color: COLORS.gold,
      fontSize: 14,
      fontWeight: "800",
    },

    /* ========================================================
       SOS + PROFILE
    ======================================================== */

    profileScreen: {
      flex: 1,
      backgroundColor: COLORS.background,
    },

    profileScroll: {
      paddingHorizontal: 22,
      paddingTop: 48,
      paddingBottom: 30,
    },

    profileHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 24,
    },

    profileEyebrow: {
      color: COLORS.goldLight,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 2,
      marginBottom: 4,
    },

    profileHeading: {
      color: COLORS.cream,
      fontSize: 34,
      fontWeight: "800",
    },

    profileEditTopButton: {
      width: 46,
      height: 46,
      borderRadius: 23,
      borderWidth: 1,
      borderColor: COLORS.goldBorder,
      backgroundColor: COLORS.card,
      alignItems: "center",
      justifyContent: "center",
    },

    profileEditTopText: {
      color: COLORS.gold,
      fontSize: 22,
      fontWeight: "700",
    },

    profileHeroCard: {
      backgroundColor: COLORS.card,
      borderRadius: 28,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      paddingVertical: 28,
      marginBottom: 26,
    },

    profileAvatar: {
      width: 88,
      height: 88,
      borderRadius: 44,
      backgroundColor: "#5A1420",
      borderWidth: 2,
      borderColor: COLORS.gold,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 14,
    },

    profileAvatarText: {
      color: COLORS.gold,
      fontSize: 36,
      fontWeight: "800",
    },

    profileName: {
      color: COLORS.cream,
      fontSize: 23,
      fontWeight: "800",
      marginBottom: 4,
    },

    profileSubtext: {
      color: COLORS.creamText,
      fontSize: 13,
      marginTop: 2,
    },

    profileSectionTitle: {
      color: COLORS.gold,
      fontSize: 17,
      fontWeight: "800",
      marginBottom: 12,
    },

    profileSectionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 22,
    },

    contactCount: {
      color: COLORS.creamText,
      fontSize: 13,
      marginBottom: 12,
    },

    profileMenuCard: {
      backgroundColor: COLORS.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      padding: 16,
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 4,
    },

    profileMenuIcon: {
      fontSize: 22,
      width: 40,
      textAlign: "center",
    },

    profileMenuTextWrap: {
      flex: 1,
      marginLeft: 10,
    },

    profileMenuTitle: {
      color: COLORS.cream,
      fontSize: 15,
      fontWeight: "700",
    },

    profileMenuSubtitle: {
      color: COLORS.creamText,
      fontSize: 12,
      marginTop: 3,
    },

    profileChevron: {
      color: COLORS.gold,
      fontSize: 25,
    },

    emptyContactsCard: {
      backgroundColor: COLORS.card,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      padding: 24,
    },

    emptyContactsIcon: {
      fontSize: 32,
      marginBottom: 8,
    },

    emptyContactsTitle: {
      color: COLORS.cream,
      fontSize: 16,
      fontWeight: "700",
      textAlign: "center",
    },

    emptyContactsText: {
      color: COLORS.creamText,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
      marginTop: 6,
    },

    contactCard: {
      backgroundColor: COLORS.cream,
      borderRadius: 19,
      padding: 12,
      marginBottom: 10,
      flexDirection: "row",
      alignItems: "center",
    },

    contactAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: "#E7D4D7",
      alignItems: "center",
      justifyContent: "center",
    },

    contactAvatarText: {
      color: COLORS.darkText,
      fontSize: 19,
      fontWeight: "800",
    },

    contactInfo: {
      flex: 1,
      minWidth: 0,
      marginLeft: 11,
    },

    contactNameRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
    },

    contactName: {
      color: COLORS.darkText,
      fontSize: 15,
      fontWeight: "800",
    },

    primaryBadge: {
      backgroundColor: "#E5F2D9",
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 3,
      marginLeft: 6,
      marginTop: 2,
    },

    primaryBadgeText: {
      color: "#3E6B2D",
      fontSize: 8,
      fontWeight: "800",
    },

    contactRelation: {
      color: "#786C6E",
      fontSize: 11,
      marginTop: 2,
    },

    contactPhone: {
      color: COLORS.darkText,
      fontSize: 12,
      fontWeight: "600",
      marginTop: 3,
    },

    contactActions: {
      flexDirection: "row",
      alignItems: "center",
      marginLeft: 5,
    },

    contactActionButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: "#F1DFE1",
      alignItems: "center",
      justifyContent: "center",
      marginLeft: 4,
    },

    contactDeleteButton: {
      backgroundColor: "#F8DADD",
    },

    addContactButton: {
      minHeight: 52,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: COLORS.goldBorder,
      backgroundColor: COLORS.card,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },

    addContactButtonIcon: {
      color: COLORS.gold,
      fontSize: 24,
      marginRight: 8,
    },

    addContactButtonText: {
      color: COLORS.gold,
      fontSize: 14,
      fontWeight: "800",
    },

    disabledButton: {
      opacity: 0.55,
    },

    profileInfoCard: {
      backgroundColor: COLORS.greenBg,
      borderWidth: 1,
      borderColor: "#326A43",
      borderRadius: 18,
      padding: 16,
      marginTop: 20,
    },

    profileInfoTitle: {
      color: COLORS.green,
      fontSize: 14,
      fontWeight: "800",
    },

    profileInfoText: {
      color: "#B9DCC2",
      fontSize: 12,
      lineHeight: 18,
      marginTop: 5,
    },

    editorScreen: {
      flex: 1,
      backgroundColor: COLORS.background,
    },

    editorScroll: {
      paddingHorizontal: 22,
      paddingTop: 44,
      paddingBottom: 40,
    },

    editorHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 26,
    },

    editorBackButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: COLORS.card,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      justifyContent: "center",
    },

    editorBackText: {
      color: COLORS.gold,
      fontSize: 30,
      lineHeight: 30,
    },

    editorTitle: {
      color: COLORS.cream,
      fontSize: 19,
      fontWeight: "800",
    },

    editorHeaderSpacer: {
      width: 44,
    },

    editorAvatarLarge: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: "#5A1420",
      borderWidth: 2,
      borderColor: COLORS.gold,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "center",
      marginBottom: 22,
    },

    editorAvatarText: {
      color: COLORS.gold,
      fontSize: 38,
      fontWeight: "800",
    },

    editorCard: {
      backgroundColor: COLORS.cream,
      borderRadius: 26,
      padding: 20,
    },

    formLabel: {
      color: COLORS.darkText,
      fontSize: 12,
      fontWeight: "800",
      marginTop: 10,
      marginBottom: 7,
    },

    formInput: {
      height: 50,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: "#DCCBCD",
      backgroundColor: "#FFF8F9",
      color: COLORS.darkText,
      paddingHorizontal: 14,
      fontSize: 14,
    },

    saveButton: {
      minHeight: 52,
      borderRadius: 15,
      backgroundColor: COLORS.background,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 22,
    },

    saveButtonText: {
      color: COLORS.gold,
      fontSize: 14,
      fontWeight: "800",
    },

    primaryToggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 18,
      paddingVertical: 8,
    },

    primaryToggleTextWrap: {
      flex: 1,
      paddingRight: 10,
    },

    primaryToggleTitle: {
      color: COLORS.darkText,
      fontSize: 13,
      fontWeight: "800",
    },

    primaryToggleSubtitle: {
      color: COLORS.creamText,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 3,
    },

    switchTrack: {
      width: 48,
      height: 28,
      borderRadius: 14,
      backgroundColor: "#D5C4C7",
      padding: 3,
      justifyContent: "center",
    },

    switchTrackActive: {
      backgroundColor: "#7E1425",
    },

    switchThumb: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: COLORS.cream,
      alignSelf: "flex-start",
    },

    switchThumbActive: {
      alignSelf: "flex-end",
    },

    sosScreen: {
      flex: 1,
      backgroundColor: COLORS.background,
    },

    sosScroll: {
      paddingHorizontal: 22,
      paddingTop: 46,
      paddingBottom: 30,
    },

    sosHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 22,
    },

    sosEyebrow: {
      color: COLORS.goldLight,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 2,
    },

    sosPageTitle: {
      color: COLORS.cream,
      fontSize: 32,
      fontWeight: "800",
      marginTop: 4,
    },

    sosHeaderTitle: {
      color: COLORS.cream,
      fontSize: 20,
      fontWeight: "800",
    },

    sosBackButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: COLORS.card,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      justifyContent: "center",
    },

    sosBackText: {
      color: COLORS.gold,
      fontSize: 30,
      lineHeight: 30,
    },

    sosHeaderSpacer: {
      width: 44,
    },

    sosIntro: {
      color: COLORS.creamText,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 18,
    },

    sosMainButton: {
      width: 220,
      height: 220,
      borderRadius: 110,
      alignSelf: "center",
      backgroundColor: "#8E1021",
      borderWidth: 14,
      borderColor: "#4E0912",
      alignItems: "center",
      justifyContent: "center",
      marginVertical: 18,
    },

    sosMainButtonPressed: {
      transform: [{ scale: 0.97 }],
    },

    sosMainButtonInner: {
      width: 168,
      height: 168,
      borderRadius: 84,
      backgroundColor: COLORS.red,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 3,
      borderColor: "#FF8990",
    },

    sosBell: {
      fontSize: 31,
      marginBottom: 4,
    },

    sosMainButtonText: {
      color: COLORS.white,
      fontSize: 42,
      fontWeight: "900",
      letterSpacing: 2,
    },

    sosHoldText: {
      color: COLORS.white,
      fontSize: 9,
      fontWeight: "800",
      letterSpacing: 1.3,
      marginTop: 3,
    },

    sosFeatureCard: {
      backgroundColor: COLORS.card,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      borderRadius: 24,
      padding: 7,
      marginTop: 6,
    },

    sosFeatureRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 9,
    },

    sosFeatureIcon: {
      width: 38,
      fontSize: 21,
      textAlign: "center",
    },

    sosFeatureTextWrap: {
      flex: 1,
      paddingHorizontal: 7,
    },

    sosFeatureTitle: {
      color: COLORS.cream,
      fontSize: 14,
      fontWeight: "800",
    },

    sosFeatureText: {
      color: COLORS.creamText,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 2,
    },

    sosFeatureArrow: {
      color: COLORS.gold,
      fontSize: 23,
    },

    sosContactsHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 24,
      marginBottom: 10,
    },

    sosSectionTitle: {
      color: COLORS.gold,
      fontSize: 17,
      fontWeight: "800",
    },

    sosContactsCount: {
      color: COLORS.creamText,
      fontSize: 12,
    },

    sosContactPreview: {
      backgroundColor: COLORS.cream,
      borderRadius: 17,
      padding: 11,
      marginBottom: 9,
      flexDirection: "row",
      alignItems: "center",
    },

    sosContactAvatar: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: "#E7D4D7",
      alignItems: "center",
      justifyContent: "center",
    },

    sosContactAvatarText: {
      color: COLORS.darkText,
      fontSize: 17,
      fontWeight: "800",
    },

    sosContactInfo: {
      flex: 1,
      marginLeft: 10,
    },

    sosContactName: {
      color: COLORS.darkText,
      fontSize: 14,
      fontWeight: "800",
    },

    sosContactPhone: {
      color: "#76696B",
      fontSize: 11,
      marginTop: 3,
    },

    primaryMini: {
      color: "#4A783A",
      backgroundColor: "#E2F0DB",
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 4,
      fontSize: 8,
      fontWeight: "800",
    },

    emptySOSContacts: {
      backgroundColor: COLORS.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      padding: 20,
    },

    emptySOSIcon: {
      fontSize: 28,
    },

    emptySOSTitle: {
      color: COLORS.cream,
      fontSize: 15,
      fontWeight: "800",
      marginTop: 6,
    },

    emptySOSText: {
      color: COLORS.creamText,
      fontSize: 11,
      textAlign: "center",
      lineHeight: 16,
      marginTop: 5,
    },

    sosNote: {
      marginTop: 18,
      padding: 12,
      borderRadius: 14,
      backgroundColor: "#321018",
      borderWidth: 1,
      borderColor: "#5A1D2B",
    },

    sosNoteText: {
      color: "#C9AEB2",
      fontSize: 10,
      lineHeight: 15,
      textAlign: "center",
    },

    activeSOSBanner: {
      backgroundColor: "#5A0712",
      borderWidth: 1,
      borderColor: COLORS.red,
      borderRadius: 22,
      padding: 16,
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 14,
    },

    activeSOSIcon: {
      fontSize: 28,
      marginRight: 12,
    },

    activeSOSTextWrap: {
      flex: 1,
    },

    activeSOSTitle: {
      color: COLORS.white,
      fontSize: 17,
      fontWeight: "900",
    },

    activeSOSSubtitle: {
      color: "#FFB0B5",
      fontSize: 12,
      marginTop: 3,
    },

    sosStatusCard: {
      backgroundColor: COLORS.card,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      borderRadius: 22,
      padding: 8,
      marginBottom: 15,
    },

    sosStatusRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      paddingHorizontal: 8,
    },

    sosStatusIcon: {
      width: 38,
      fontSize: 19,
      textAlign: "center",
    },

    sosStatusTextWrap: {
      flex: 1,
      marginLeft: 8,
    },

    sosStatusTitle: {
      color: COLORS.cream,
      fontSize: 13,
      fontWeight: "800",
    },

    sosStatusValue: {
      color: COLORS.creamText,
      fontSize: 10,
      marginTop: 2,
    },

    sosStatusCheck: {
      color: COLORS.red,
      fontSize: 20,
      fontWeight: "900",
    },

    sosStatusCheckActive: {
      color: COLORS.green,
    },

    locationCard: {
      backgroundColor: COLORS.greenBg,
      borderWidth: 1,
      borderColor: "#326A43",
      borderRadius: 20,
      padding: 15,
      marginBottom: 18,
    },

    locationCardTitle: {
      color: COLORS.green,
      fontSize: 13,
      fontWeight: "800",
    },

    locationCardText: {
      color: "#C9E6D0",
      fontSize: 12,
      marginTop: 5,
    },

    updateLocationButton: {
      alignSelf: "flex-start",
      backgroundColor: "#245335",
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginTop: 10,
    },

    updateLocationText: {
      color: COLORS.green,
      fontSize: 10,
      fontWeight: "800",
    },

    sosContactRow: {
      backgroundColor: COLORS.cream,
      borderRadius: 17,
      padding: 11,
      marginBottom: 8,
      flexDirection: "row",
      alignItems: "center",
    },

    sosSentText: {
      color: "#8B777B",
      fontSize: 10,
      fontWeight: "800",
    },

    sosSentTextActive: {
      color: "#3C7B4C",
    },

    stopSOSButton: {
      minHeight: 54,
      borderRadius: 16,
      backgroundColor: COLORS.red,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 18,
    },

    stopSOSButtonText: {
      color: COLORS.white,
      fontSize: 15,
      fontWeight: "900",
    },

    /* ========================================================
       ROUTE SCREEN
    ======================================================== */

    routeContainer: {
      flex: 1,
      backgroundColor:
        COLORS.background,
    },

    routeScroll: {
      paddingHorizontal: 22,
      paddingTop: 16,

      /*
        Increased bottom padding so
        Share Route and Start Navigation
        never get hidden behind bottom nav.
      */
      paddingBottom: 170,
    },

    routeHeader: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 15,
    },

    backButton: {
      width: 42,
      height: 42,
      alignItems: "center",
      justifyContent: "center",
    },

    backArrow: {
      color: COLORS.cream,
      fontSize: 39,
      lineHeight: 39,
      fontWeight: "300",
    },

    routeHeaderText: {
      flex: 1,
      marginLeft: 4,
    },

    routeTo: {
      color:
        COLORS.goldLight,
      fontSize: 14,
    },

    routeDestination: {
      color: COLORS.gold,
      fontSize: 23,
      fontWeight: "800",
      marginTop: 1,
    },

    menuDots: {
      color: COLORS.cream,
      fontSize: 28,
      paddingHorizontal: 5,
    },

    /* ========================================================
       MAP
    ======================================================== */

    mapCard: {
      height: 405,
      borderRadius: 23,
      overflow: "hidden",
      borderWidth: 1,
      borderColor:
        COLORS.cardBorder,
      backgroundColor:
        "#17161B",
    },

    map: {
      flex: 1,
    },

    mapLoading: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 30,
      backgroundColor:
        "#17080A",
    },

    mapLoadingTitle: {
      color: COLORS.gold,
      fontSize: 18,
      fontWeight: "800",
      marginTop: 14,
      textAlign: "center",
    },

    mapLoadingText: {
      color: COLORS.cream,
      opacity: 0.75,
      fontSize: 13,
      textAlign: "center",
      marginTop: 7,
      lineHeight: 19,
    },

    errorIcon: {
      color: COLORS.red,
      fontSize: 34,
    },

    retryButton: {
      marginTop: 18,
      borderWidth: 1,
      borderColor:
        COLORS.goldBorder,
      borderRadius: 18,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },

    retryText: {
      color: COLORS.gold,
      fontWeight: "700",
    },

    /* ========================================================
       MAP MARKERS
    ======================================================== */

    startMarker: {
      width: 27,
      height: 27,
      borderRadius: 14,
      backgroundColor:
        COLORS.cream,
      borderWidth: 3,
      borderColor:
        "#D9B676",
      alignItems: "center",
      justifyContent: "center",
    },

    markerDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor:
        "#9B6B3E",
    },

    destinationMarker: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor:
        COLORS.red,
      borderWidth: 3,
      borderColor:
        COLORS.cream,
      alignItems: "center",
      justifyContent: "center",
    },

    destinationMarkerText: {
      color: COLORS.red,
      fontSize: 12,
    },

    /* ========================================================
       ROUTE HEADER
    ======================================================== */

    safetyDataNote: {
      color: COLORS.cream,
      opacity: 0.58,
      fontSize: 10.5,
      lineHeight: 15,
      marginBottom: 10,
      paddingHorizontal: 2,
    },

    routeOptionsHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent:
        "space-between",
    },

    sortText: {
      color: COLORS.cream,
      fontSize: 12,
      marginTop: 20,
    },

    sortHighlight: {
      color: COLORS.gold,
      fontWeight: "700",
    },

    /* ========================================================
       ROUTE CARD
    ======================================================== */

    routeOption: {
      minHeight: 142,
      borderWidth: 1.3,
      borderRadius: 21,
      padding: 13,
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 11,
    },

    routeLeft: {
      flex: 1,
      flexDirection: "row",
      alignItems: "flex-start",
    },

    routeOptionIcon: {
      fontSize: 25,
      width: 36,
      marginTop: 2,
    },

    routeOptionContent: {
      flex: 1,
      paddingRight: 4,
    },

    routeTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 7,
    },

    routeOptionTitle: {
      fontSize: 16,
      fontWeight: "800",
    },

    recommendedBadge: {
      borderWidth: 1,
      borderColor:
        COLORS.green,
      borderRadius: 10,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },

    recommendedText: {
      color: COLORS.green,
      fontSize: 9,
      fontWeight: "700",
    },

    routeStats: {
      color: COLORS.cream,
      fontSize: 15,
      marginTop: 7,
    },

    routeDescription: {
      color: COLORS.cream,
      opacity: 0.7,
      fontSize: 10.5,
      marginTop: 5,
      lineHeight: 15,
    },

    routeChevron: {
      color: COLORS.cream,
      fontSize: 29,
      marginLeft: 3,
    },

    /* ========================================================
       RISKIOMETER
    ======================================================== */

    riskometerContainer: {
      width: 145,
      minHeight: 116,
      borderLeftWidth: 1,
      borderLeftColor:
        "#8B2639",
      paddingLeft: 10,
      justifyContent:
        "center",
    },

    riskometerTitle: {
      color: COLORS.cream,
      fontSize: 11,
      fontWeight: "600",
      marginBottom: 3,
    },

    riskometerBody: {
      height: 78,
      flexDirection: "row",
      alignItems: "center",
    },

    /* ========================================================
       GAUGE
    ======================================================== */

    gaugeWrapper: {
      width: 72,
      height: 65,
      justifyContent:
        "flex-end",
      alignItems: "center",
      overflow: "visible",
    },

    gaugeOuter: {
      width: 72,
      height: 40,
      borderTopLeftRadius: 72,
      borderTopRightRadius: 72,
      borderWidth: 8,
      borderBottomWidth: 0,
      borderColor:
        "#F08AA9",
      position: "relative",
      overflow: "visible",
    },

    gaugeInner: {
      position: "absolute",
      left: 7,
      right: 7,
      top: 8,
      height: 26,
      borderTopLeftRadius: 50,
      borderTopRightRadius: 50,
      borderWidth: 7,
      borderBottomWidth: 0,
      borderColor:
        "#680A22",
    },

    /* ========================================================
       NEEDLE
    ======================================================== */

    gaugeNeedleFixed: {
      position: "absolute",
      width: 3,
      height: 38,
      backgroundColor:
        COLORS.cream,
      borderRadius: 3,
    },

    needleCenterFixed: {
      position: "absolute",
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor:
        COLORS.cream,
    },

    /* ========================================================
       RISK SCORE
    ======================================================== */

    riskScoreContainer: {
      flex: 1,
      alignItems:
        "flex-start",
      justifyContent:
        "center",
      marginLeft: 4,
    },

    riskScore: {
      fontSize: 20,
      fontWeight: "800",
    },

    riskScoreTotal: {
      fontSize: 10,
      fontWeight: "600",
    },

    riskBadge: {
      marginTop: 5,
      paddingHorizontal: 7,
      paddingVertical: 5,
      borderRadius: 13,
    },

    riskBadgeText: {
      color:
        COLORS.darkText,
      fontSize: 8.5,
      fontWeight: "800",
    },

    /* ========================================================
       SAFETY INSIGHTS
    ======================================================== */

    insightRow: {
      flexDirection: "row",
      gap: 7,
    },

    insightCard: {
      flex: 1,
      minHeight: 104,
      borderWidth: 1,
      borderColor:
        COLORS.cardBorder,
      borderRadius: 16,
      backgroundColor:
        COLORS.card,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 3,
    },

    insightIcon: {
      fontSize: 21,
      marginBottom: 5,
    },

    insightValue: {
      color: COLORS.cream,
      fontSize: 15,
      fontWeight: "700",
    },

    insightLabel: {
      color: COLORS.cream,
      opacity: 0.7,
      fontSize: 9,
      textAlign: "center",
      marginTop: 3,
    },

    /* ========================================================
       SAFE PLACES
    ======================================================== */

    safePlacesHeader: {
      flexDirection: "row",
      justifyContent:
        "space-between",
      alignItems: "center",
      marginTop: 4,
      marginBottom: 12,
    },

    seeAll: {
      color: COLORS.gold,
      fontSize: 13,
      fontWeight: "700",
    },

    placesRow: {
      flexDirection: "row",
      gap: 8,
    },

    nearbyCard: {
      flex: 1,
      borderWidth: 1,
      borderColor:
        COLORS.cardBorder,
      borderRadius: 16,
      overflow: "hidden",
      backgroundColor:
        COLORS.card,
      paddingBottom: 9,
    },

    placeImagePlaceholder: {
      height: 65,
      backgroundColor:
        "#24141A",
      alignItems: "center",
      justifyContent: "center",
    },

    placeIcon: {
      fontSize: 26,
    },

    placeName: {
      color: COLORS.cream,
      fontSize: 11,
      fontWeight: "700",
      marginHorizontal: 8,
      marginTop: 7,
    },

    placeDistance: {
      color: COLORS.cream,
      opacity: 0.75,
      fontSize: 9,
      marginHorizontal: 8,
      marginTop: 4,
    },

    openText: {
      color: COLORS.green,
    },

    /* ========================================================
       LAWS & HELPLINES
    ======================================================== */

    lawsHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 20,
      marginBottom: 10,
    },

    lawsCard: {
      borderWidth: 1.2,
      borderColor: COLORS.goldBorder,
      borderRadius: 20,
      backgroundColor: COLORS.card,
      overflow: "hidden",
    },

    lawsCardHeader: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 15,
      paddingTop: 14,
      paddingBottom: 10,
    },

    lawsIcon: {
      color: COLORS.gold,
      fontSize: 27,
      marginRight: 11,
    },

    lawsHeaderText: {
      flex: 1,
    },

    lawsTitle: {
      color: COLORS.gold,
      fontSize: 16,
      fontWeight: "800",
    },

    lawsSubtitle: {
      color: COLORS.cream,
      opacity: 0.65,
      fontSize: 10,
      marginTop: 2,
    },

    lawRow: {
      flexDirection: "row",
      alignItems: "center",
      borderTopWidth: 1,
      borderTopColor: "#651323",
      paddingHorizontal: 11,
      paddingVertical: 10,
      minHeight: 68,
    },

    lawRowExpanded: {
      backgroundColor: "#3B0008",
      alignItems: "flex-start",
    },

    lawIconCircle: {
      width: 31,
      height: 31,
      borderRadius: 16,
      backgroundColor: "#4A0811",
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 9,
      marginTop: 1,
    },

    lawRowIcon: {
      color: COLORS.gold,
      fontSize: 15,
    },

    lawMain: {
      flex: 1,
      paddingRight: 5,
    },

    lawName: {
      color: COLORS.cream,
      fontSize: 12,
      fontWeight: "800",
    },

    lawSection: {
      color: COLORS.pinkLight,
      fontSize: 9,
      fontWeight: "700",
      marginTop: 2,
    },

    lawPunishment: {
      color: COLORS.gold,
      fontSize: 10,
      fontWeight: "700",
      marginTop: 3,
      lineHeight: 14,
    },

    lawDetail: {
      color: COLORS.cream,
      opacity: 0.72,
      fontSize: 9.5,
      lineHeight: 14,
      marginTop: 6,
    },

    lawChevron: {
      color: COLORS.gold,
      fontSize: 24,
      width: 20,
      textAlign: "center",
      marginLeft: 2,
    },

    lawDisclaimer: {
      color: COLORS.cream,
      opacity: 0.48,
      fontSize: 8.5,
      lineHeight: 13,
      paddingHorizontal: 13,
      paddingTop: 9,
      paddingBottom: 12,
    },

    helplineRow: {
      flexDirection: "row",
      gap: 7,
      marginTop: 9,
    },

    helplineCard: {
      flex: 1,
      minHeight: 93,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      borderRadius: 15,
      backgroundColor: COLORS.card,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 3,
      paddingVertical: 8,
    },

    helplineIcon: {
      color: COLORS.pinkLight,
      fontSize: 18,
      marginBottom: 3,
    },

    helplineValue: {
      color: COLORS.gold,
      fontSize: 15,
      fontWeight: "800",
    },

    helplineLabel: {
      color: COLORS.cream,
      fontSize: 9,
      fontWeight: "700",
      textAlign: "center",
      marginTop: 2,
    },

    helplineSub: {
      color: COLORS.cream,
      opacity: 0.58,
      fontSize: 7.5,
      textAlign: "center",
      marginTop: 2,
    },

    /* ========================================================
       RISK ANALYSIS
    ======================================================== */

    riskAnalysisHeader: {
      flexDirection: "row",
      justifyContent:
        "space-between",
      alignItems: "center",
      marginTop: 20,
      marginBottom: 12,
    },

    analysisRow: {
      flexDirection: "row",
      gap: 7,
    },

    analysisCard: {
      flex: 1,
      minHeight: 82,
      borderWidth: 1,
      borderColor:
        COLORS.cardBorder,
      borderRadius: 14,
      backgroundColor:
        COLORS.card,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 3,
    },

    analysisIcon: {
      fontSize: 17,
      marginBottom: 4,
    },

    analysisValue: {
      color: COLORS.cream,
      fontSize: 13,
      fontWeight: "800",
    },

    analysisTitle: {
      color: COLORS.cream,
      opacity: 0.65,
      fontSize: 8,
      textAlign: "center",
      marginTop: 3,
    },

    /* ========================================================
       SHARE
    ======================================================== */

    shareButton: {
      height: 60,
      borderRadius: 20,
      borderWidth: 1.3,
      borderColor:
        COLORS.goldBorder,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 20,
    },

    shareIcon: {
      color: COLORS.gold,
      fontSize: 28,
      marginRight: 10,
    },

    shareText: {
      color: COLORS.gold,
      fontSize: 17,
      fontWeight: "700",
    },

    /* ========================================================
       NAVIGATION SCREEN
    ======================================================== */

    navigationContainer: {
      flex: 1,
      backgroundColor:
        COLORS.background,
      paddingHorizontal: 16,
      paddingTop: 18,
    },

    navigationScroll: {
      paddingBottom: 30,
    },

    navigationHeader: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 12,
    },

    navigationBackButton: {
      width: 42,
      height: 42,
      alignItems: "center",
      justifyContent: "center",
    },

    navigationBackArrow: {
      color: COLORS.cream,
      fontSize: 39,
      lineHeight: 39,
      fontWeight: "300",
    },

    navigationHeaderText: {
      flex: 1,
      marginLeft: 3,
      marginRight: 8,
    },

    navigationEyebrow: {
      color: COLORS.goldLight,
      fontSize: 9,
      fontWeight: "800",
      letterSpacing: 1.5,
    },

    navigationTitle: {
      color: COLORS.gold,
      fontSize: 18,
      fontWeight: "800",
      marginTop: 2,
    },

    navigationRouteBadge: {
      borderWidth: 1,
      borderRadius: 13,
      paddingHorizontal: 9,
      paddingVertical: 6,
      maxWidth: 105,
    },

    navigationRouteBadgeText: {
      fontSize: 9,
      fontWeight: "800",
      textAlign: "center",
    },

    navigationMapCard: {
      height: 410,
      borderRadius: 24,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      backgroundColor: "#17161B",
      position: "relative",
    },

    navigationMapCardExpanded: {
      height: 650,
      borderRadius: 24,
    },

    navigationMap: {
      flex: 1,
    },

    navigationExpandedTopCard: {
      position: "absolute",
      top: 12,
      left: 12,
      right: 12,
      minHeight: 64,
      borderRadius: 16,
      backgroundColor: "rgba(25, 24, 30, 0.96)",
      borderWidth: 1,
      borderColor: "#5B5962",
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 9,
    },

    navigationExpandedTurnIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: COLORS.gold,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 10,
    },

    navigationExpandedTurnIconText: {
      color: COLORS.darkText,
      fontSize: 24,
      fontWeight: "900",
    },

    navigationExpandedTopText: {
      flex: 1,
    },

    navigationExpandedDistance: {
      color: COLORS.cream,
      fontSize: 13,
      fontWeight: "800",
    },

    navigationExpandedInstruction: {
      color: COLORS.cream,
      opacity: 0.78,
      fontSize: 10,
      marginTop: 2,
      fontWeight: "600",
    },

    navigationExpandedBottomCard: {
      position: "absolute",
      left: 12,
      right: 12,
      bottom: 42,
      minHeight: 62,
      borderRadius: 16,
      backgroundColor: "rgba(25, 24, 30, 0.96)",
      borderWidth: 1,
      borderColor: "#5B5962",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingLeft: 14,
      paddingRight: 8,
    },

    navigationExpandedBottomStats: {
      flex: 1,
    },

    navigationExpandedBottomMain: {
      color: COLORS.cream,
      fontSize: 14,
      fontWeight: "800",
    },

    navigationExpandedBottomSub: {
      color: COLORS.cream,
      opacity: 0.62,
      fontSize: 9,
      marginTop: 2,
    },

    navigationExpandedEndButton: {
      minWidth: 58,
      height: 42,
      borderRadius: 12,
      backgroundColor: COLORS.red,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 12,
    },

    navigationExpandedEndText: {
      color: COLORS.white,
      fontSize: 12,
      fontWeight: "900",
    },

    navigationExpandedSafetyBar: {
      position: "absolute",
      left: 12,
      right: 12,
      bottom: 8,
      height: 28,
      borderRadius: 10,
      backgroundColor: "rgba(42, 0, 4, 0.94)",
      borderWidth: 1,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 9,
    },

    navigationExpandedSafetyIcon: {
      fontSize: 15,
      marginRight: 7,
    },

    navigationExpandedSafetyText: {
      color: COLORS.cream,
      fontSize: 9,
      fontWeight: "700",
    },

    navigationExpandedCollapseHint: {
      position: "absolute",
      top: 84,
      alignSelf: "center",
      backgroundColor: "rgba(42, 0, 4, 0.88)",
      borderRadius: 10,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },

    navigationExpandedCollapseHintText: {
      color: COLORS.cream,
      opacity: 0.72,
      fontSize: 8,
      fontWeight: "700",
    },

    navigationPreviewBadge: {
      position: "absolute",
      top: 12,
      left: 12,
      backgroundColor: "rgba(42,0,4,0.90)",
      borderWidth: 1,
      borderColor: COLORS.goldBorder,
      borderRadius: 13,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },

    navigationPreviewBadgeText: {
      color: COLORS.gold,
      fontSize: 9,
      fontWeight: "800",
    },

    navigationPreviewBadgeExpanded: {
      top: 84,
      left: 12,
    },

    navigationRecenter: {
      position: "absolute",
      right: 12,
      bottom: 12,
      backgroundColor: COLORS.card,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      borderRadius: 16,
      paddingHorizontal: 10,
      paddingVertical: 8,
      flexDirection: "row",
      alignItems: "center",
    },

    navigationRecenterIcon: {
      color: COLORS.gold,
      fontSize: 17,
      marginRight: 5,
    },

    navigationRecenterText: {
      color: COLORS.cream,
      fontSize: 9,
      fontWeight: "700",
    },

    liveLocationMarker: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: "rgba(65, 150, 255, 0.18)",
      borderWidth: 2,
      borderColor: "#4D9BFF",
      alignItems: "center",
      justifyContent: "center",
    },

    liveLocationArrow: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: "#2F80FF",
      borderWidth: 3,
      borderColor: COLORS.white,
      alignItems: "center",
      justifyContent: "center",
    },

    liveLocationArrowText: {
      color: COLORS.white,
      fontSize: 15,
      lineHeight: 18,
      fontWeight: "900",
      marginTop: -1,
    },

    liveLocationCore: {
      position: "absolute",
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: COLORS.white,
    },

    navigationLiveLocationCard: {
      marginTop: 10,
      borderWidth: 1,
      borderRadius: 17,
      backgroundColor: COLORS.card,
      paddingHorizontal: 12,
      paddingVertical: 11,
      flexDirection: "row",
      alignItems: "center",
    },

    navigationLiveLocationDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: "#2F80FF",
      marginRight: 9,
    },

    navigationLiveLocationBody: {
      flex: 1,
      paddingRight: 8,
    },

    navigationLiveLocationTitle: {
      color: COLORS.gold,
      fontSize: 9,
      fontWeight: "900",
      letterSpacing: 1,
    },

    navigationLiveLocationText: {
      color: COLORS.cream,
      opacity: 0.72,
      fontSize: 9,
      marginTop: 2,
      lineHeight: 13,
    },

    navigationLiveLocationDistance: {
      color: COLORS.cream,
      fontSize: 12,
      fontWeight: "900",
    },

    navigationStartMarker: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: COLORS.cream,
      borderWidth: 3,
      borderColor: COLORS.gold,
      alignItems: "center",
      justifyContent: "center",
    },

    navigationStartDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: "#9B6B3E",
    },

    navigationDestinationMarker: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: COLORS.red,
      borderWidth: 3,
      borderColor: COLORS.cream,
      alignItems: "center",
      justifyContent: "center",
    },

    navigationDestinationMarkerText: {
      color: COLORS.red,
      fontSize: 12,
    },

    navigationSummaryCard: {
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      borderRadius: 21,
      backgroundColor: COLORS.card,
      padding: 14,
      marginTop: 12,
    },

    navigationSummaryTop: {
      flexDirection: "row",
      alignItems: "center",
    },

    navigationShield: {
      width: 42,
      height: 42,
      borderRadius: 15,
      backgroundColor: "#4A0811",
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      justifyContent: "center",
    },

    navigationShieldText: {
      fontSize: 20,
    },

    navigationSummaryTitleBox: {
      flex: 1,
      marginLeft: 10,
    },

    navigationSummaryTitle: {
      color: COLORS.gold,
      fontSize: 16,
      fontWeight: "800",
    },

    navigationSummarySubtitle: {
      color: COLORS.cream,
      opacity: 0.65,
      fontSize: 10,
      marginTop: 3,
    },

    navigationStatsRow: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: "#651323",
    },

    navigationStat: {
      flex: 1,
      alignItems: "center",
    },

    navigationStatDivider: {
      width: 1,
      height: 32,
      backgroundColor: "#651323",
    },

    navigationStatValue: {
      color: COLORS.cream,
      fontSize: 14,
      fontWeight: "800",
    },

    navigationStatLabel: {
      color: COLORS.cream,
      opacity: 0.55,
      fontSize: 8,
      marginTop: 3,
      textAlign: "center",
    },

    navigationInstructionCard: {
      flexDirection: "row",
      borderWidth: 1,
      borderColor: COLORS.goldBorder,
      borderRadius: 21,
      backgroundColor: "#3B0008",
      padding: 14,
      marginTop: 12,
    },

    navigationInstructionIcon: {
      width: 42,
      height: 42,
      borderRadius: 15,
      backgroundColor: COLORS.gold,
      alignItems: "center",
      justifyContent: "center",
    },

    navigationInstructionIconText: {
      color: COLORS.darkText,
      fontSize: 23,
      fontWeight: "800",
    },

    navigationInstructionBody: {
      flex: 1,
      marginLeft: 11,
    },

    navigationInstructionLabel: {
      color: COLORS.gold,
      fontSize: 8.5,
      fontWeight: "800",
      letterSpacing: 1,
    },

    navigationInstructionTitle: {
      color: COLORS.cream,
      fontSize: 14,
      fontWeight: "800",
      marginTop: 4,
    },

    navigationInstructionText: {
      color: COLORS.cream,
      opacity: 0.62,
      fontSize: 9.5,
      lineHeight: 14,
      marginTop: 5,
    },

    navigationSafetyCard: {
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      borderRadius: 19,
      backgroundColor: COLORS.card,
      padding: 14,
      marginTop: 12,
    },

    navigationSafetyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },

    navigationSafetyTitle: {
      color: COLORS.cream,
      fontSize: 14,
      fontWeight: "800",
    },

    navigationSafetyScore: {
      fontSize: 14,
      fontWeight: "800",
    },

    navigationSafetyText: {
      color: COLORS.cream,
      opacity: 0.6,
      fontSize: 9.5,
      lineHeight: 14,
      marginTop: 5,
    },

    navigationSafetyBar: {
      height: 7,
      borderRadius: 4,
      backgroundColor: "#5A1A25",
      overflow: "hidden",
      marginTop: 10,
    },

    navigationSafetyBarFill: {
      height: "100%",
      borderRadius: 4,
    },

    navigationSOSButton: {
      minHeight: 64,
      borderRadius: 20,
      backgroundColor: COLORS.redBg,
      borderWidth: 1.2,
      borderColor: COLORS.red,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 15,
      marginTop: 12,
    },

    navigationSOSIcon: {
      color: COLORS.red,
      fontSize: 24,
      width: 34,
      textAlign: "center",
    },

    navigationSOSTextBox: {
      flex: 1,
      marginLeft: 8,
    },

    navigationSOSTitle: {
      color: COLORS.cream,
      fontSize: 14,
      fontWeight: "800",
    },

    navigationSOSSubtitle: {
      color: COLORS.cream,
      opacity: 0.55,
      fontSize: 9,
      marginTop: 2,
    },

    navigationSOSArrow: {
      color: COLORS.red,
      fontSize: 24,
      fontWeight: "800",
    },

    navigationEndButton: {
      height: 56,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: COLORS.cardBorder,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 10,
    },

    navigationEndText: {
      color: COLORS.gold,
      fontSize: 15,
      fontWeight: "800",
    },

    navigationFooterNote: {
      color: COLORS.cream,
      opacity: 0.4,
      fontSize: 8.5,
      lineHeight: 13,
      textAlign: "center",
      paddingHorizontal: 15,
      marginTop: 11,
    },

    /* ========================================================
       START NAVIGATION
    ======================================================== */

    startNavigationButton: {
      height: 64,
      borderRadius: 21,
      backgroundColor:
        "#F3C96D",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 12,
    },

    startNavigationText: {
      color: COLORS.card,
      fontSize: 18,
      fontWeight: "800",
    },

    startNavigationArrow: {
      color: COLORS.card,
      fontSize: 28,
      marginLeft: 12,
      fontWeight: "800",
    },
  });
