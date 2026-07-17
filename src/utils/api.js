import { haversine } from "./geo";

// ─── OSRM Routing API ────────────────────────────────────────────────────────

const OSRM_BASE = "https://router.project-osrm.org";

// Map app profiles to OSRM profiles
function osrmProfile(appProfile) {
  const map = {
    "driving-car": "driving",
    "cycling-regular": "cycling",
    "foot-walking": "walking",
  };
  return map[appProfile] || "driving";
}

export async function getRoute(coords, profile = "driving-car") {
  // Strip elevation to [lon, lat] — OSRM only accepts 2D
  const flat = coords.map(c => c.length > 2 ? [c[0], c[1]] : c);
  // OSRM expects lon,lat pairs separated by semicolons
  const locs = flat.map(([lng, lat]) => `${lng},${lat}`).join(";");
  const url = `${OSRM_BASE}/route/v1/${osrmProfile(profile)}/${locs}?geometries=geojson&overview=full&alternatives=false&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM error ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(data.message || "OSRM returned no route");
  }
  const route = data.routes[0];
  // Normalize OSRM response into GeoJSON FeatureCollection
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: route.geometry.coordinates,
      },
      properties: {
        summary: { distance: route.distance, duration: route.duration },
      },
    }],
  };
}

// ─── Elevation (OpenTopoData via proxy) ──────────────────────────────────────

export async function enrichElevation(geojson) {
  const coords = geojson.features[0].geometry.coordinates;
  if (!coords || coords.length === 0) return geojson;
  // Don't re-fetch if already 3D
  if (coords[0].length >= 3) return geojson;

  // Downsample to ~200 points max for API efficiency
  let sampleCoords = coords;
  if (coords.length > 200) {
    const step = coords.length / 200;
    sampleCoords = [];
    for (let i = 0; i < coords.length; i++) {
      if (i % Math.ceil(step) === 0 || i === coords.length - 1) {
        sampleCoords.push(coords[i]);
      }
    }
  }

  // Build lookup map: "lng,lat" → elevation
  const lookup = new Map();
  try {
    const MAX_PER_REQUEST = 100;
    const batchFetches = [];
    const batchData = [];

    for (let i = 0; i < sampleCoords.length; i += MAX_PER_REQUEST) {
      const batch = sampleCoords.slice(i, i + MAX_PER_REQUEST);
      const locs = batch.map(([lng, lat]) => `${lat},${lng}`).join("|");
      const url = `https://api.opentopodata.org/v1/aster30m?locations=${locs}`;
      const proxyUrl = `https://custom-proxy-sage.vercel.app/?url=${encodeURIComponent(url)}`;
      batchData.push(batch);
      batchFetches.push(
        fetch(proxyUrl).then(res => {
          if (!res.ok) throw new Error(`OpenTopoData error ${res.status}`);
          return res.json();
        })
      );
    }
    // Fire all requests in parallel
    const allData = await Promise.all(batchFetches);
    allData.forEach((data, idx) => {
      const batch = batchData[idx];
      if (data.results) {
        data.results.forEach((r, j) => {
          if (r.elevation != null) {
            const [lng, lat] = batch[j];
            lookup.set(`${lng},${lat}`, r.elevation);
          }
        });
      }
    });
  } catch (e) {
    console.warn("Elevation fetch failed (non-fatal):", e.message);
    return geojson; // Non-fatal — return original 2D coords
  }

  // Interpolate elevation for all original coordinates
  const enriched = coords.map(c => {
    const key = `${c[0]},${c[1]}`;
    const ele = lookup.get(key);
    if (ele != null) return [c[0], c[1], ele];
    // Find nearest sampled point
    let best = null, bestDist = Infinity;
    for (const [k, v] of lookup) {
      const [lk, ll] = k.split(",").map(Number);
      const d = haversine([c[0], c[1]], [lk, ll]);
      if (d < bestDist) { bestDist = d; best = v; }
    }
    return [c[0], c[1], best || 0];
  });

  return {
    ...geojson,
    features: [{ ...geojson.features[0], geometry: { ...geojson.features[0].geometry, coordinates: enriched } }],
  };
}

// ─── Distance & Elevation Profile ────────────────────────────────────────────

export function routeDistanceKm(geojson) {
  return geojson.features[0].properties.summary.distance / 1000;
}

export function extractElevationProfile(geojson) {
  const coords = geojson.features[0].geometry.coordinates;
  if (!coords || coords.length < 2) return [];
  const hasElevation = coords.some(c => c.length >= 3 && c[2] != null);
  if (!hasElevation) return [];

  let cumDist = 0;
  const profile = [{ distKm: 0, ele: coords[0][2] || 0 }];
  for (let i = 1; i < coords.length; i++) {
    cumDist += haversine(coords[i - 1], coords[i]);
    profile.push({ distKm: cumDist / 1000, ele: coords[i][2] || 0 });
  }
  return profile;
}

export function sampleIntermediateWaypoints(geojson, n = 3) {
  const coords = geojson.features[0].geometry.coordinates;
  const step = Math.floor(coords.length / (n + 1));
  const result = [];
  for (let i = 1; i <= n; i++) result.push(coords[i * step]);
  return result;
}
