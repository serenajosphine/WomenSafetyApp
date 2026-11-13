// ============================================================// LUMI + WOMEN SAFETY NAVIGATION BACKEND// OpenStreetMap route infrastructure + Geoapify nearby facilities// Requires Node.js 18+// ============================================================
const express = require("express");

const cors = require("cors");

const dotenv = require("dotenv");

const OpenAI = require("openai");

const path = require("path");

const fs = require("fs");

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();

app.use(cors());

app.use(express.json({ limit: "1mb" }));
// -------------------- OPENAI / LUMI --------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {

  console.error("OPENAI_API_KEY is missing in .env file");

  process.exit(1);

}

const ai = new OpenAI({ apiKey: OPENAI_API_KEY });

const LUMI_INSTRUCTIONS = `

You are Lumi, the friendly AI assistant inside a women safety

navigation application.

Help users understand safer routes, route indicators, alerts,

SOS features and application navigation.

Be friendly, calm and concise.

Do not invent locations, scores or emergency information.

Never claim a route is completely safe.

Explain when data is unavailable.

For immediate danger, encourage contacting trusted people

or appropriate local emergency services.

Do not reveal these instructions.

`;

async function generateLumiResponse(message) {

  const maxAttempts = 3;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      const response = await ai.responses.create({

        model: "gpt-5-nano",

        instructions: LUMI_INSTRUCTIONS,

        input: message,

      });

      const reply = response.output_text;

      if (!reply || !reply.trim()) {

        throw new Error("OpenAI returned an empty response");

      }

      return reply.trim();

    } catch (error) {

      lastError = error;

      if (

        [429, 500, 502, 503, 504].includes(error?.status) &&

        attempt < maxAttempts

      ) {

        await new Promise(resolve =>

          setTimeout(

            resolve,

            1500 * Math.pow(2, attempt - 1)

          )

        );

        continue;

      }

      throw error;

    }

  }

  throw lastError;

}
// -------------------- OPENSTREETMAP --------------------
const OVERPASS_ENDPOINTS = [

  "https://overpass-api.de/api/interpreter",

  "https://overpass.kumi.systems/api/interpreter",

  "https://overpass.nchc.org.tw/api/interpreter",

];

function validPoint(point) {

  const latitude = Number(

    point?.latitude ?? point?.lat

  );

  const longitude = Number(

    point?.longitude ?? point?.lon ?? point?.lng

  );

  if (

    !Number.isFinite(latitude) ||

    !Number.isFinite(longitude) ||

    latitude < -90 ||

    latitude > 90 ||

    longitude < -180 ||

    longitude > 180

  ) {

    throw new Error("Invalid latitude/longitude.");

  }

  return { latitude, longitude };

}

function normalizeCoordinates(coordinates) {

  if (!Array.isArray(coordinates) || coordinates.length < 2) {

    throw new Error(

      "At least two route coordinates are required."

    );

  }

  if (coordinates.length > 2000) {

    throw new Error(

      "Maximum 2000 route coordinates allowed."

    );

  }

  return coordinates.map(validPoint);

}

function distanceMeters(a, b) {

  const rad = value => value * Math.PI / 180;

  const dLat = rad(b.latitude - a.latitude);

  const dLon = rad(b.longitude - a.longitude);

  const lat1 = rad(a.latitude);

  const lat2 = rad(b.latitude);

  const h =

    Math.sin(dLat / 2) ** 2 +

    Math.cos(lat1) *

    Math.cos(lat2) *

    Math.sin(dLon / 2) ** 2;

  return 6371000 *

    2 *

    Math.atan2(

      Math.sqrt(h),

      Math.sqrt(1 - h)

    );

}
// Sample actual route at approximately 150 metre intervals.
function sampleCoordinates(

  coordinates,

  spacingMeters = 150,

  maxSamples = 35

) {

  const cumulative = [0];

  for (let i = 1; i < coordinates.length; i++) {

    cumulative.push(

      cumulative[i - 1] +

      distanceMeters(

        coordinates[i - 1],

        coordinates[i]

      )

    );

  }

  const total = cumulative[cumulative.length - 1];

  if (!Number.isFinite(total) || total < 1) {

    return [coordinates[0]];

  }

  const count = Math.min(

    maxSamples,

    Math.max(

      2,

      Math.ceil(total / spacingMeters) + 1

    )

  );

  const samples = [];

  for (let n = 0; n < count; n++) {

    const target = total * n / (count - 1);

    let i = 1;

    while (

      i < cumulative.length - 1 &&

      cumulative[i] < target

    ) {

      i++;

    }

    const segmentLength =

      cumulative[i] - cumulative[i - 1];

    const ratio = segmentLength > 0

      ? (target - cumulative[i - 1]) / segmentLength

      : 0;

    samples.push({

      latitude:

        coordinates[i - 1].latitude +

        (coordinates[i].latitude -

          coordinates[i - 1].latitude) * ratio,

      longitude:

        coordinates[i - 1].longitude +

        (coordinates[i].longitude -

          coordinates[i - 1].longitude) * ratio,

    });

  }

  return samples;

}

function escapeNumber(value) {

  return Number(value).toFixed(6);

}

async function queryOverpass(query) {

  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {

    try {

      const response = await fetch(endpoint, {

        method: "POST",

        headers: {

          "Content-Type":

            "application/x-www-form-urlencoded;charset=UTF-8",

          "User-Agent": "WomenSafetyNavigationApp/1.0",

        },

        body: new URLSearchParams({ data: query }),

        signal: AbortSignal.timeout(7000),

      });

      if (!response.ok) {

        throw new Error(

          `OpenStreetMap returned HTTP ${response.status}`

        );

      }

      const data = await response.json();

      if (!Array.isArray(data.elements)) {

        throw new Error(

          "Invalid OpenStreetMap response."

        );

      }

      return data.elements;

    } catch (error) {

      lastError = error;

      console.error(

        `Overpass endpoint failed (${endpoint}):`,

        error.message

      );

    }

  }

  throw lastError ||

    new Error(

      "OpenStreetMap is currently unavailable."

    );

}

function elementPoint(element) {

  const lat = element.lat ?? element.center?.lat;

  const lon = element.lon ?? element.center?.lon;

  if (

    !Number.isFinite(Number(lat)) ||

    !Number.isFinite(Number(lon))

  ) {

    return null;

  }

  return {

    latitude: Number(lat),

    longitude: Number(lon),

  };

}

function uniqueElements(elements) {

  const map = new Map();

  for (const element of elements) {

    map.set(

      `${element.type}/${element.id}`,

      element

    );

  }

  return [...map.values()];

}
// -------------------- ROUTE DATA QUERY --------------------
function buildRouteQuery(samples) {

  const clauses = samples.map(point => {

    const lat = escapeNumber(point.latitude);

    const lon = escapeNumber(point.longitude);

    return `

      way["highway"]["lit"](around:35,${lat},${lon});

      nwr["highway"="street_lamp"]

      (around:35,${lat},${lon});

      way["highway"]["sidewalk"]

      (around:35,${lat},${lon});

      way["highway"~"^(footway|pedestrian|path)$"]

      (around:35,${lat},${lon});

      nwr["amenity"~"^(police|hospital|clinic|pharmacy|bus_station)$"]

      (around:300,${lat},${lon});

      nwr["shop"](around:120,${lat},${lon});

    `;

  }).join("\n");

  return `

    [out:json][timeout:25];

    (

      ${clauses}

    );

    out center tags;

  `;

}
// -------------------- ANALYSE ROUTE DATA --------------------
function analyseRouteInfrastructure(samples, elements) {

  const roads = elements.filter(

    item =>

      item.tags?.highway &&

      item.tags?.highway !== "street_lamp"

  );

  const lamps = elements.filter(

    item => item.tags?.highway === "street_lamp"

  );

  const pedestrianWays = elements.filter(item =>

    ["footway", "pedestrian", "path"].includes(

      item.tags?.highway

    ) || Boolean(item.tags?.sidewalk)

  );

  const facilities = elements.filter(item =>

    [

      "police",

      "hospital",

      "clinic",

      "pharmacy",

      "bus_station",

    ].includes(item.tags?.amenity)

  );

  const shops = elements.filter(

    item => item.tags?.shop

  );

  let knownLightingPoints = 0;

  let litEvidencePoints = 0;

  let unlitEvidencePoints = 0;

  let unknownLightingPoints = 0;

  for (const sample of samples) {

    const nearbyRoads = roads.filter(road => {

      const point = elementPoint(road);

      return point &&

        distanceMeters(sample, point) <= 35;

    });

    const nearbyLamps = lamps.some(lamp => {

      const point = elementPoint(lamp);

      return point &&

        distanceMeters(sample, point) <= 35;

    });

    const litTags = nearbyRoads

      .map(road =>

        String(road.tags?.lit || "").toLowerCase()

      )

      .filter(Boolean);

    const hasLit = litTags.some(value =>

      ["yes", "automatic", "24/7"].includes(value)

    );

    const hasUnlit = litTags.some(

      value => value === "no"

    );

    if (hasLit || nearbyLamps) {

      knownLightingPoints++;

      litEvidencePoints++;

    } else if (hasUnlit) {

      knownLightingPoints++;

      unlitEvidencePoints++;

    } else {

      unknownLightingPoints++;

    }

  }

  const infrastructureIndex =

    knownLightingPoints > 0

      ? Math.round(

          litEvidencePoints /

          knownLightingPoints * 100

        )

      : null;

  const facilityCounts = {

    police: facilities.filter(

      x => x.tags.amenity === "police"

    ).length,

    hospitals: facilities.filter(

      x => x.tags.amenity === "hospital"

    ).length,

    clinics: facilities.filter(

      x => x.tags.amenity === "clinic"

    ).length,

    pharmacies: facilities.filter(

      x => x.tags.amenity === "pharmacy"

    ).length,

    busStations: facilities.filter(

      x => x.tags.amenity === "bus_station"

    ).length,

    shops: shops.length,

  };

  return {

    infrastructureIndex,

    dataAvailable: infrastructureIndex !== null,

    dataCoverage: {

      routeSamplePoints: samples.length,

      knownLightingPoints,

      litEvidencePoints,

      unlitEvidencePoints,

      unknownLightingPoints,

      mappedRoadObjects: roads.length,

      mappedStreetLamps: lamps.length,

      mappedPedestrianWays: pedestrianWays.length,

      mappedFacilities: facilities.length,

      mappedShops: shops.length,

      lightingDataCompleteness: Math.round(

        knownLightingPoints /

        Math.max(samples.length, 1) * 100

      ),

    },

    facilityCounts,

    breakdown: [{

      name: "Mapped lighting evidence",

      score: infrastructureIndex,

      detail: infrastructureIndex === null

        ? "No explicit lighting information was found."

        : `${litEvidencePoints} of ${knownLightingPoints} known route points had mapped lighting support.`,

    }],

    note:

      "This is a mapped-lighting indicator, not a crime-risk score. Missing tags mean unknown, not unlit.",

  };

}
// -------------------- BENGALURU WARD DATA --------------------
const DATA_DIR = path.join(__dirname, "..", "data");

const WARD_GEOJSON_PATH = path.join(

  DATA_DIR,

  "bengaluru_wards_2023.geojson"

);

const STREETLIGHT_CSV_PATH = path.join(

  DATA_DIR,

  "bengaluru_ward_streetlights_clean.csv"

);

const RISK_LOCATIONS_JSON_PATH = path.join(

  DATA_DIR,

  "bengaluru_risk_locations_cleaned.json"

);

const HISTORICAL_LOCATIONS_JSON_PATH = path.join(
  DATA_DIR,
  "historical_locations.json"
);

const FACILITIES_JSON_PATH = path.join(
  DATA_DIR,
  "bengaluru_hospitals_and_police_stations.json"
);
let wardGeoJSON;

let legacyStreetlightRows = [];

let riskLocations = [];
let historicalLocations = [];
let facilityLocations = [];

function loadWardFiles() {

  if (!fs.existsSync(WARD_GEOJSON_PATH)) {

    throw new Error(

      "Missing data/bengaluru_wards_2023.geojson"

    );

  }

  if (!fs.existsSync(STREETLIGHT_CSV_PATH)) {

    throw new Error(

      "Missing data/bengaluru_ward_streetlights_clean.csv"

    );

  }

  wardGeoJSON = JSON.parse(

    fs.readFileSync(WARD_GEOJSON_PATH, "utf8")

  );

  const csv = fs.readFileSync(

    STREETLIGHT_CSV_PATH,

    "utf8"

  );

  const lines = csv.trim().split(/\r?\n/);

  const headers = lines[0].split(",").map(x => x.trim());

  const wardNoIndex = headers.indexOf("ward_no");

  const wardNameIndex = headers.indexOf("ward_name");

  const countIndex = headers.indexOf("streetlight_count");

  if (

    wardNoIndex === -1 ||

    wardNameIndex === -1 ||

    countIndex === -1

  ) {

    throw new Error(

      "Streetlight CSV must contain ward_no, ward_name, streetlight_count"

    );

  }

  legacyStreetlightRows = lines.slice(1).map(line => {

    const values = line.split(",");

    return {

      wardNo: Number(values[wardNoIndex]),

      wardName: values[wardNameIndex]?.trim(),

      streetlightCount: Number(values[countIndex])

    };

  }).filter(row =>

    Number.isFinite(row.wardNo) &&

    Number.isFinite(row.streetlightCount)

  );

  console.log(

    `Loaded ${wardGeoJSON.features.length} ward boundaries`

  );

  console.log(

    `Loaded ${legacyStreetlightRows.length} legacy streetlight records`

  );

}
// Check whether a geographic point lies inside a polygon ring.
function pointInRing(point, ring) {

  const x = point.longitude;

  const y = point.latitude;

  let inside = false;

  for (

    let i = 0, j = ring.length - 1;

    i < ring.length;

    j = i++

  ) {

    const xi = ring[i][0];

    const yi = ring[i][1];

    const xj = ring[j][0];

    const yj = ring[j][1];

    const intersects =

      ((yi > y) !== (yj > y)) &&

      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);

    if (intersects) inside = !inside;

  }

  return inside;

}
// GeoJSON coordinates use [longitude, latitude].
function pointInPolygon(point, polygonCoordinates) {

  if (!pointInRing(point, polygonCoordinates[0])) {

    return false;

  }
// A point inside a hole is not inside the polygon.
  for (let i = 1; i < polygonCoordinates.length; i++) {

    if (pointInRing(point, polygonCoordinates[i])) {

      return false;

    }

  }

  return true;

}

function findWardForPoint(point) {

  if (!wardGeoJSON?.features) return null;

  for (const feature of wardGeoJSON.features) {

    const geometry = feature.geometry;

    if (!geometry) continue;

    let matched = false;

    if (geometry.type === "Polygon") {

      matched = pointInPolygon(

        point,

        geometry.coordinates

      );

    }

    if (geometry.type === "MultiPolygon") {

      matched = geometry.coordinates.some(polygon =>

        pointInPolygon(point, polygon)

      );

    }

    if (matched) {

      const properties = feature.properties || {};

      return {

        wardId: properties.id ?? null,

        wardName:

          properties.name_en ||

          properties.proposed_ward_name_en ||

          "Unknown ward"

      };

    }

  }

  return null;

}
// Return all ward boundaries.
app.get("/api/ward-boundaries", (req, res) => {

  if (!wardGeoJSON) {

    return res.status(503).json({

      success: false,

      error: "Ward boundary data is not loaded."

    });

  }

  res.json({

    success: true,

    wardCount: wardGeoJSON.features.length,

    dataSource: "2023 ward boundary GeoJSON",

    geojson: wardGeoJSON

  });

});
// Return the wards crossed by each submitted route.
app.post("/api/ward-data", (req, res) => {

  try {

    const inputRoutes = req.body?.routes;

    if (

      !Array.isArray(inputRoutes) ||

      inputRoutes.length === 0 ||

      inputRoutes.length > 3

    ) {

      return res.status(400).json({

        success: false,

        error: "Provide between 1 and 3 routes."

      });

    }

    const results = inputRoutes.map((route, index) => {

      const coordinates = normalizeCoordinates(

        route?.coordinates

      );

      const samples = sampleCoordinates(

        coordinates,

        100,

        100

      );

      const matchedWards = new Map();

      let unmatchedPoints = 0;

      for (const point of samples) {

        const ward = findWardForPoint(point);

        if (ward) {

          matchedWards.set(

            String(ward.wardId),

            ward

          );

        } else {

          unmatchedPoints++;

        }

      }

      return {

        id: String(route?.id ?? `route-${index + 1}`),

        sampledPoints: samples.length,

        unmatchedPoints,

        wards: [...matchedWards.values()],

        wardCount: matchedWards.size

      };

    });

    res.json({

      success: true,

      dataSource: "2023 Bengaluru ward boundaries",

      note:

        "Ward matching uses sampled route coordinates. It identifies geographic ward areas, not road-level safety.",

      streetlightDataNote:

        "The available streetlight CSV contains 198 legacy ward records and has not been reassigned to the 225 newer wards.",

      routes: results

    });

  } catch (error) {

    console.error("Ward data error:", error.message);

    res.status(400).json({

      success: false,

      error: error.message

    });

  }

});
// Return the original streetlight CSV records separately.
app.get("/api/legacy-streetlights", (req, res) => {

  res.json({

    success: true,

    recordCount: legacyStreetlightRows.length,

    dataSource: "Original Bengaluru 198-ward streetlight CSV",

    note:

      "These historical ward totals are not directly matched to the 225 newer ward boundaries.",

    records: legacyStreetlightRows

  });

});
// Load local ward files when the backend starts.
try {

  loadWardFiles();

} catch (error) {

  console.error(

    "WARD DATA LOADING ERROR:",

    error.message

  );

}
// -------------------- RISK-LOCATION DATA --------------------
function loadRiskLocations() {

  if (!fs.existsSync(RISK_LOCATIONS_JSON_PATH)) {

    console.warn(

      "Risk-location JSON not found:",

      RISK_LOCATIONS_JSON_PATH

    );

    riskLocations = [];

    return;

  }

  const parsed = JSON.parse(

    fs.readFileSync(

      RISK_LOCATIONS_JSON_PATH,

      "utf8"

    )

  );

  const riskRows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.locations)
    ? parsed.locations
    : null;

  if (!riskRows) {
    throw new Error(
      "Risk-location JSON must be an array or contain a locations array."
    );
  }

  riskLocations = riskRows

    .map((item, index) => {

      const latitude = Number(item.latitude);

      const longitude = Number(item.longitude);

      const locationName = String(
        item.location_name || item.place_name || item.name || ""
      ).trim();

      const reason = Array.isArray(item.risk_reasons)
        ? item.risk_reasons.join(", ")
        : String(item.reason || item.risk_reasons || "No reason supplied.");

      if (
        !locationName ||

        !Number.isFinite(latitude) ||

        !Number.isFinite(longitude) ||

        latitude < -90 || latitude > 90 ||

        longitude < -180 || longitude > 180

      ) {

        console.warn(

          `Skipping invalid risk-location record at index ${index}.`

        );

        return null;

      }

      return {

        id: item.id ?? index + 1,

        location_name: locationName,

        latitude,

        longitude,

        category: item.category || "Risk-prone",

        reason,

        risk_level: item.risk_level || null,

        verification_status:

          item.verification_status || "Unverified",

        source_note: item.source_note || null

      };

    })

    .filter(Boolean);

  console.log(

    `Loaded ${riskLocations.length} risk-location records`

  );

}

// -------------------- LOCAL FACILITY DATA --------------------
function loadFacilityLocations() {
  if (!fs.existsSync(FACILITIES_JSON_PATH)) {
    console.warn("Facilities JSON not found:", FACILITIES_JSON_PATH);
    facilityLocations = [];
    return;
  }

  const parsed = JSON.parse(fs.readFileSync(FACILITIES_JSON_PATH, "utf8"));
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.facilities)
    ? parsed.facilities
    : [];

  facilityLocations = rows.map((item, index) => {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    const name = String(item.name || item.location_name || "").trim();

    if (
      !name ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) return null;

    const category = String(item.category || item.type || "").toLowerCase();
    const type = category.includes("police")
      ? "Police"
      : category.includes("hospital")
      ? "Hospital"
      : category.includes("clinic")
      ? "Clinic"
      : category.includes("pharmacy")
      ? "Pharmacy"
      : "Facility";

    return {
      id: item.id ?? index + 1,
      name,
      type,
      category: item.category || type,
      latitude,
      longitude,
      dataSource: "User-supplied facilities dataset"
    };
  }).filter(Boolean);

  console.log(`Loaded ${facilityLocations.length} facility records`);
}

app.get("/api/facility-locations", (req, res) => {
  try {
    const center = validPoint({
      latitude: req.query.lat,
      longitude: req.query.lon
    });
    const radius = Math.max(250, Math.min(10000, Number(req.query.radius) || 2500));

    const locations = facilityLocations
      .map(place => ({
        ...place,
        distanceKm: Number((distanceMeters(center, place) / 1000).toFixed(2))
      }))
      .filter(place => place.distanceKm * 1000 <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return res.json({
      success: true,
      count: locations.length,
      center,
      radiusMeters: radius,
      locations,
      note: "Facilities are from the supplied project dataset and may be incomplete or outdated."
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
      locations: []
    });
  }
});

try {
  loadFacilityLocations();
} catch (error) {
  console.error("FACILITY DATA LOADING ERROR:", error.message);
  facilityLocations = [];
}

// -------------------- HISTORICAL LOCATION DATA --------------------

function loadHistoricalLocations() {
  if (!fs.existsSync(HISTORICAL_LOCATIONS_JSON_PATH)) {
    console.warn(
      "Historical-location JSON not found:",
      HISTORICAL_LOCATIONS_JSON_PATH
    );
    historicalLocations = [];
    return;
  }

  const parsed = JSON.parse(
    fs.readFileSync(HISTORICAL_LOCATIONS_JSON_PATH, "utf8")
  );

  if (!Array.isArray(parsed)) {
    throw new Error(
      "Historical-location JSON must contain a top-level array."
    );
  }

  historicalLocations = parsed
    .map((item, index) => {
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      const name = String(item.name || "").trim();
      const reason = String(item.reason || "").trim();

      if (
        !name ||
        !reason ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180
      ) {
        console.warn(
          `Skipping invalid historical-location record at index ${index}.`
        );
        return null;
      }

      return {
        id: item.id ?? index + 1,
        name,
        latitude,
        longitude,
        reason,
        category: "Historical reported location",
        verification_status: item.verification_status || "Unverified"
      };
    })
    .filter(Boolean);

  console.log(
    `Loaded ${historicalLocations.length} historical-location records`
  );
}

// Return all historical locations for the frontend map's separate marker layer.
app.get("/api/historical-locations", (req, res) => {
  res.json({
    success: true,
    count: historicalLocations.length,
    dataSource: "User-supplied historical-location dataset",
    markerColor: "#D97706",
    note:
      "Locations and descriptions are user-supplied and have not been independently verified. Markers indicate approximate area coordinates, not exact incident locations.",
    locations: historicalLocations
  });
});

try {
  loadHistoricalLocations();
} catch (error) {
  console.error(
    "HISTORICAL LOCATION DATA LOADING ERROR:",
    error.message
  );
  historicalLocations = [];
}

// Find saved risk locations near a submitted route.
function findRiskLocationsNearRoute(

  routeCoordinates,

  radiusMeters = 150

) {

  if (!riskLocations.length) {

    return {

      riskLocationDataAvailable: false,

      nearbyRiskLocationCount: 0,

      nearbyRiskLocations: [],

      riskLocationNote:

        "Risk-location dataset is not loaded."

    };

  }

  const samples = sampleCoordinates(

    routeCoordinates,

    100,

    500

  );

  const matches = [];

  for (const location of riskLocations) {

    const riskPoint = {

      latitude: location.latitude,

      longitude: location.longitude

    };

    let nearestDistance = Infinity;

    for (const sample of samples) {

      const distance = distanceMeters(

        sample,

        riskPoint

      );

      if (distance < nearestDistance) {

        nearestDistance = distance;

      }

    }

    if (nearestDistance <= radiusMeters) {

      matches.push({

        ...location,

        distanceFromRouteMeters:

          Math.round(nearestDistance)

      });

    }

  }

  matches.sort(

    (a, b) =>

      a.distanceFromRouteMeters -

      b.distanceFromRouteMeters

  );

  return {

    riskLocationDataAvailable: true,

    proximityRadiusMeters: radiusMeters,

    nearbyRiskLocationCount: matches.length,

    nearbyRiskLocations: matches,

    riskLocationNote:

      "Approximate proximity matches to user-supplied points; not verified crime locations or a definitive danger assessment."

  };

}
// Historical reports are kept separate from general user-marked risk areas.
// Proximity is approximate because each record represents an area coordinate.
function findHistoricalLocationsNearRoute(routeCoordinates, radiusMeters = 200) {
  if (!historicalLocations.length) {
    return {
      historicalDataAvailable: false,
      nearbyHistoricalCount: 0,
      nearbyHistoricalLocations: [],
    };
  }

  const samples = sampleCoordinates(routeCoordinates, 100, 500);
  const matches = [];
  for (const location of historicalLocations) {
    const point = { latitude: location.latitude, longitude: location.longitude };
    let nearestDistance = Infinity;
    for (const sample of samples) {
      nearestDistance = Math.min(nearestDistance, distanceMeters(sample, point));
    }
    if (nearestDistance <= radiusMeters) {
      matches.push({ ...location, distanceFromRouteMeters: Math.round(nearestDistance) });
    }
  }
  matches.sort((a, b) => a.distanceFromRouteMeters - b.distanceFromRouteMeters);
  return {
    historicalDataAvailable: true,
    historicalProximityRadiusMeters: radiusMeters,
    nearbyHistoricalCount: matches.length,
    nearbyHistoricalLocations: matches,
  };
}

function buildRouteRiskAssessment(routeCoordinates, infrastructureIndex) {
  const risk = findRiskLocationsNearRoute(routeCoordinates);
  const historical = findHistoricalLocationsNearRoute(routeCoordinates);
  const riskCount = risk.nearbyRiskLocationCount || 0;
  const historicalCount = historical.nearbyHistoricalCount || 0;

  // Exposure score is a transparent comparison heuristic, not a probability.
  // Each nearby mapped point adds exposure; values are capped at 100.
  const mappedRiskExposure = Math.min(100, riskCount * 18);
  const historicalExposure = Math.min(100, historicalCount * 22);
  const lightingExposure = Number.isFinite(infrastructureIndex)
    ? 100 - infrastructureIndex
    : null;
  const available = [
    { value: mappedRiskExposure, weight: 0.40 },
    ...(historical.historicalDataAvailable
      ? [{ value: historicalExposure, weight: 0.45 }]
      : []),
    ...(lightingExposure == null
      ? []
      : [{ value: lightingExposure, weight: 0.15 }]),
  ];
  const weightTotal = available.reduce((sum, item) => sum + item.weight, 0);
  const riskScore = weightTotal > 0
    ? Math.round(available.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal)
    : null;

  return {
    ...risk,
    ...historical,
    riskScore,
    safetyScore: riskScore == null ? null : 100 - riskScore,
    riskAssessmentAvailable: riskScore != null,
    riskAssessmentMethod: "Proximity-based comparison heuristic; not a verified incident-rate or personal safety prediction.",
  };
}

// Return all saved risk locations for map markers.
app.get("/api/risk-locations", (req, res) => {

  res.json({

    success: true,

    count: riskLocations.length,

    dataSource: "User-supplied risk-location dataset",

    note:

      "Coordinates and risk descriptions are user-supplied and have not been independently verified.",

    locations: riskLocations

  });

});

try {

  loadRiskLocations();

} catch (error) {

  console.error(

    "RISK LOCATION DATA LOADING ERROR:",

    error.message

  );

  riskLocations = [];

}
// -------------------- HEALTH CHECK --------------------
app.get("/", (req, res) => {

  res.json({

    message:

      "Lumi and Women Safety backend running successfully",

    status: "online",

    services: [

      "OpenAI Lumi chatbot",

      "OpenStreetMap route infrastructure",

      "Geoapify nearby facilities",

      "Bengaluru risk-location dataset",
      "Historical-location dataset",
      "Local hospital and police-station dataset"

    ],

  });

});
// -------------------- SAFETY DATA API --------------------
const safetyDataCache = new Map();

const SAFETY_CACHE_TTL = 10 * 60 * 1000;

app.post("/api/safety-data", async (req, res) => {

  try {

    const inputRoutes = req.body?.routes;

    if (

      !Array.isArray(inputRoutes) ||

      inputRoutes.length === 0 ||

      inputRoutes.length > 3

    ) {

      return res.status(400).json({

        success: false,

        error: "Provide between 1 and 3 routes.",

      });

    }

    const routes = inputRoutes.map((route, index) => ({

      id: String(route?.id ?? `route-${index + 1}`),

      coordinates: normalizeCoordinates(route?.coordinates),

    }));

    const results = await Promise.all(

      routes.map(async (route) => {

        const samples = sampleCoordinates(

          route.coordinates,

          300,

          12

        );

        const cacheKey = JSON.stringify(

          samples.map(point => [

            point.latitude.toFixed(4),

            point.longitude.toFixed(4),

          ])

        );

        const cached = safetyDataCache.get(cacheKey);

        if (

          cached &&

          Date.now() - cached.timestamp < SAFETY_CACHE_TTL

        ) {

          return {

            id: route.id,

            ...cached.data,

            ...findRiskLocationsNearRoute(route.coordinates),

            cached: true,

          };

        }

        try {

          const elements = await Promise.race([

            queryOverpass(buildRouteQuery(samples)),

            new Promise((_, reject) =>

              setTimeout(

                () => reject(

                  new Error("Safety data request timed out")

                ),

                9000

              )

            ),

          ]);

          const analysis = analyseRouteInfrastructure(

            samples,

            uniqueElements(elements)

          );

          safetyDataCache.set(cacheKey, {

            timestamp: Date.now(),

            data: analysis,

          });

          return {

            id: route.id,

            ...analysis,

            ...findRiskLocationsNearRoute(route.coordinates),

            cached: false,

          };

        } catch (error) {

          console.warn(

            `Safety data unavailable for ${route.id}:`,

            error.message

          );

          return {

            id: route.id,

            infrastructureIndex: null,

            dataAvailable: false,

            dataCoverage: {

              routeSamplePoints: samples.length,

              knownLightingPoints: 0,

              litEvidencePoints: 0,

              unlitEvidencePoints: 0,

              unknownLightingPoints: samples.length,

              lightingDataCompleteness: 0,

            },

            facilityCounts: {

              police: 0,

              hospitals: 0,

              clinics: 0,

              pharmacies: 0,

              busStations: 0,

              shops: 0,

            },

            breakdown: [],

            ...buildRouteRiskAssessment(route.coordinates, null),

            note:

              "Live infrastructure data is temporarily unavailable. No safety score has been calculated.",

            cached: false,

          };

        }

      })

    );

    return res.json({

      success: true,

      dataSource: "OpenStreetMap",

      routes,

      results,

      note:

        "Unavailable infrastructure data is not assigned a safety score.",

    });

  } catch (error) {

    console.error(

      "Safety API error:",

      error.message

    );

    return res.status(400).json({

      success: false,

      error:

        error.message ||

        "Unable to process safety data.",

    });

  }

});
// -------------------- GEOAPIFY NEARBY FACILITIES API --------------------// Geoapify is the single provider for nearby facilities.// Keep GEOAPIFY_API_KEY in lumi-backend/.env only.
const nearbyPlacesCache = new Map();

const NEARBY_CACHE_TTL_MS = 3 * 60 * 1000;

app.get("/api/nearby-places", async (req, res) => {

  try {

    const center = validPoint({

      latitude: req.query.lat,

      longitude: req.query.lon,

    });

    const radius = Math.max(

      250,

      Math.min(

        5000,

        Number(req.query.radius) || 2500

      )

    );

    const cacheKey =

      `${center.latitude.toFixed(4)}:` +

      `${center.longitude.toFixed(4)}:${radius}`;

    const cached = nearbyPlacesCache.get(cacheKey);

    if (

      cached &&

      Date.now() - cached.savedAt < NEARBY_CACHE_TTL_MS

    ) {

      return res.json({

        ...cached.payload,

        cached: true,

      });

    }

    const apiKey = process.env.GEOAPIFY_API_KEY;

    if (!apiKey) {

      return res.status(500).json({

        success: false,

        error:

          "GEOAPIFY_API_KEY is missing from lumi-backend/.env.",

        places: [],

      });

    }

    const params = new URLSearchParams({

      categories: [

        "healthcare.hospital",

        "healthcare.clinic_or_praxis",

        "healthcare.pharmacy",

        "service.police",

        "service.fire_station",

        "public_transport.bus",

        "catering.cafe",

        "catering.restaurant",

      ].join(","),

      filter:

        `circle:${center.longitude},${center.latitude},${radius}`,

      limit: "40",

      apiKey,

    });

    const response = await fetch(

      `https://api.geoapify.com/v2/places?${params.toString()}`,

      {

        signal: AbortSignal.timeout(15000),

      }

    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {

      const providerMessage =

        data?.message ||

        data?.error ||

        `HTTP ${response.status}`;

      throw new Error(

        `Geoapify request failed: ${providerMessage}`

      );

    }

    const labels = {

      "healthcare.hospital": "Hospital",

      "healthcare.clinic_or_praxis": "Clinic",

      "healthcare.pharmacy": "Pharmacy",

      "service.police": "Police Station",

      "service.fire_station": "Fire Station",

      "public_transport.bus": "Bus / Transit",

      "catering.cafe": "Cafe",

      "catering.restaurant": "Restaurant",

    };

    const features = Array.isArray(data.features)

      ? data.features

      : [];

    const places = features.map((feature, index) => {

      const properties = feature?.properties || {};

      const coordinates =

        feature?.geometry?.coordinates || [];

      const longitude = Number(

        properties.lon ?? coordinates[0]

      );

      const latitude = Number(

        properties.lat ?? coordinates[1]

      );

      if (

        !Number.isFinite(latitude) ||

        !Number.isFinite(longitude) ||

        latitude < -90 ||

        latitude > 90 ||

        longitude < -180 ||

        longitude > 180

      ) {

        return null;

      }

      const categories = Array.isArray(properties.categories)

        ? properties.categories

        : [];

      const matchedCategory = categories.find(

        category => labels[category]

      );

      const type =

        labels[matchedCategory] || "Facility";

      const point = {

        latitude,

        longitude,

      };

      const distanceKm = Number(

        (

          distanceMeters(center, point) / 1000

        ).toFixed(2)

      );

      if (distanceKm * 1000 > radius) {

        return null;

      }

      return {

        id: `geoapify-${properties.place_id || index}`,

        name:

          properties.name ||

          properties.address_line1 ||

          properties.formatted ||

          type,

        type,

        distanceKm,

        latitude,

        longitude,

        dataSource: "Geoapify",

      };

    }).filter(Boolean);

    places.sort(

      (a, b) => a.distanceKm - b.distanceKm

    );

    const payload = {

      success: true,

      center,

      radiusMeters: radius,

      count: places.length,

      places: places.slice(0, 40),

      dataSource: "Geoapify",

      note:

        "Nearby facilities are based on public map listings and may be incomplete or outdated. They are not verified emergency-response locations.",

    };

    nearbyPlacesCache.set(cacheKey, {

      savedAt: Date.now(),

      payload,

    });

    if (nearbyPlacesCache.size > 100) {

      const oldestKey =

        nearbyPlacesCache.keys().next().value;

      nearbyPlacesCache.delete(oldestKey);

    }

    return res.json(payload);

  } catch (error) {

    console.error(

      "Nearby places error:",

      error.message

    );

    return res.status(502).json({

      success: false,

      error:

        error.message ||

        "Unable to retrieve nearby facilities.",

      places: [],

    });

  }

});
// -------------------- LUMI CHATBOT API --------------------
app.post("/api/lumi", async (req, res) => {

  try {

    const { message } = req.body || {};

    if (

      !message ||

      typeof message !== "string" ||

      !message.trim()

    ) {

      return res.status(400).json({

        error: "Please provide a valid message.",

      });

    }

    if (message.length > 5000) {

      return res.status(400).json({

        error: "Message is too long.",

      });

    }

    const reply = await generateLumiResponse(message);

    res.status(200).json({ reply });

  } catch (error) {

    console.error("OpenAI error:", error.message);

    const status = error?.status;

    if (status === 401) {

      return res.status(500).json({

        error: "Lumi's API configuration is invalid.",

      });

    }

    if (status === 429) {

      return res.status(429).json({

        error: "Lumi has reached an API usage limit.",

      });

    }

    if ([500, 502, 503, 504].includes(status)) {

      return res.status(503).json({

        error: "Lumi is temporarily unavailable.",

      });

    }

    res.status(500).json({

      error: "Lumi could not respond right now.",

    });

  }

});
// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {

  console.log("============================================");

  console.log("       LUMI BACKEND RUNNING");

  console.log("============================================");

  console.log(`Server: http://localhost:${PORT}`);

  console.log(

    `Lumi API: http://localhost:${PORT}/api/lumi`

  );

  console.log(

    `Safety API: http://localhost:${PORT}/api/safety-data`

  );

  console.log(

    `Nearby API: http://localhost:${PORT}/api/nearby-places`

  );

  console.log(

    `Risk locations API: http://localhost:${PORT}/api/risk-locations`

  );

  console.log("Nearby facilities provider: Geoapify");

  console.log("Route infrastructure provider: OpenStreetMap");

  console.log("============================================");

});
