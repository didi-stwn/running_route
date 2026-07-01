import React, { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const OSRM_BASE = "https://router.project-osrm.org";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toRad(d) { return d * Math.PI / 180; }

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearing([lon1, lat1], [lon2, lat2]) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function movePoint([lon, lat], brng, dist) {
  const R = 6371000, d = dist / R, b = toRad(brng);
  const lat1 = toRad(lat), lon1 = toRad(lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  if (!data.length) throw new Error(`Location "${query}" not found`);
  return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
}

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  return data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// Map app profiles to OSRM profiles
function osrmProfile(appProfile) {
  const map = {
    "driving-car": "driving",
    "cycling-regular": "cycling",
    "cycling-mountain": "cycling",
    "foot-walking": "walking",
    "foot-hiking": "walking",
  };
  return map[appProfile] || "driving";
}

async function getRoute(coords, profile = "driving-car") {
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
  // Normalize OSRM response into the same GeoJSON shape that ORS used
  const geojson = {
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
  // Enrich with elevation data (non-fatal — returns original if API fails)
  return await enrichElevation(geojson);
}

// Enrich 2D coordinates [lng, lat] with elevation data from Open-Elevation API
async function enrichElevation(geojson) {
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
    // Query in batches of 100
    for (let i = 0; i < sampleCoords.length; i += 100) {
      const batch = sampleCoords.slice(i, i + 100);
      const locations = batch.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
      const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations }),
      });
      if (!res.ok) throw new Error(`Elevation API error ${res.status}`);
      const data = await res.json();
      data.results.forEach((r, j) => {
        const [lng, lat] = batch[j];
        lookup.set(`${lng},${lat}`, r.elevation);
      });
    }
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

// Build a ONE-WAY detour route — all waypoints offset to one side of the direct
// road line, creating an arc that never doubles back on itself.
// side: 1 = right of road, -1 = left of road
function buildOneWayDetour(roadCoords, offsetMeters, numWaypoints = 3, side = 1) {
  if (roadCoords.length < 2 || offsetMeters <= 0) {
    return [roadCoords[0], roadCoords[roadCoords.length - 1]];
  }

  const step = Math.floor((roadCoords.length - 2) / (numWaypoints + 1));
  const result = [roadCoords[0]];

  for (let i = 0; i < numWaypoints; i++) {
    const idx = 1 + step * (i + 1);
    if (idx >= roadCoords.length - 1) {
      result.push(roadCoords[Math.min(idx, roadCoords.length - 2)]);
      continue;
    }
    const pt = roadCoords[idx];
    const prev = roadCoords[idx - 1];
    const next = roadCoords[idx + 1];
    const roadBrng = bearing(prev, next);
    // side=1 pushes RIGHT (clockwise 90°), side=-1 pushes LEFT (counter-clockwise 90°)
    const perpBrng = ((roadBrng + 90 * side) % 360 + 360) % 360;
    // Scale offset — middle waypoints get larger offset, first/last get smaller
    const curve = Math.sin(((i + 1) / (numWaypoints + 1)) * Math.PI);
    const actualDist = offsetMeters * curve;
    const shifted = movePoint(pt, perpBrng, actualDist);
    result.push(shifted);
  }

  result.push(roadCoords[roadCoords.length - 1]);
  return result;
}

function routeDistanceKm(geojson) {
  return geojson.features[0].properties.summary.distance / 1000;
}

// Extract [distance (km), elevation (m)] pairs from route coordinates
function extractElevationProfile(geojson) {
  const coords = geojson.features[0].geometry.coordinates;
  if (!coords || coords.length < 2) return [];
  // Check if elevation data exists (3rd element in each coordinate)
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

function sampleIntermediateWaypoints(geojson, n = 3) {
  const coords = geojson.features[0].geometry.coordinates;
  const step = Math.floor(coords.length / (n + 1));
  const result = [];
  for (let i = 1; i <= n; i++) result.push(coords[i * step]);
  return result;
}

function exportGPX(routeGeoJson, distanceKm) {
  const coords = routeGeoJson.features[0].geometry.coordinates;
  const now = new Date().toISOString();
  const trkpts = coords.map(([lon, lat, ele]) =>
    `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele ? `<ele>${ele.toFixed(1)}</ele>` : ""}</trkpt>`
  ).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunRoute" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>RunRoute ${distanceKm} km</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `route-${distanceKm}km.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Invalid GPX XML");

  const trkpts = doc.querySelectorAll("trkpt");
  if (!trkpts.length) throw new Error("No track points found in GPX");
  const coords = [];
  trkpts.forEach(pt => {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    const eleEl = pt.querySelector("ele");
    const ele = eleEl ? parseFloat(eleEl.textContent) : 0;
    if (!isNaN(lat) && !isNaN(lon)) coords.push([lon, lat, ele]);
  });
  if (coords.length < 2) throw new Error("Need at least 2 track points");

  const geojson = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: { summary: { distance: 0, duration: 0 } },
    }],
  };

  // Compute total distance
  let totalDist = 0;
  for (let i = 1; i < coords.length; i++) {
    totalDist += haversine(coords[i - 1], coords[i]);
  }
  geojson.features[0].properties.summary.distance = totalDist;

  return {
    geojson,
    startCoord: [coords[0][0], coords[0][1]],
    endCoord: [coords[coords.length - 1][0], coords[coords.length - 1][1]],
    distanceKm: (totalDist / 1000).toFixed(2),
    waypointCount: coords.length,
  };
}

// ─── Style Constants ──────────────────────────────────────────────────────────
const S = {
  app: { display: "flex", height: "100vh", fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", background: "#0d1117", color: "#e6edf3", overflow: "hidden" },
  panel: { width: 340, minWidth: 310, background: "#161b22", borderRight: "1px solid #21262d", padding: "20px 16px", display: "flex", flexDirection: "column", overflowY: "auto", gap: "6px" },
  logo: { fontSize: 11, letterSpacing: 4, color: "#22ff88", textTransform: "uppercase", marginBottom: 2, fontWeight: 700 },
  title: { fontSize: 18, fontWeight: 700, color: "#e6edf3", lineHeight: 1.2, marginBottom: 12, fontFamily: "'Inter','Segoe UI',sans-serif" },
  label: { fontSize: 10, letterSpacing: 2, color: "#8b949e", textTransform: "uppercase", marginBottom: 4, display: "block" },
  input: { width: "100%", background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, padding: "9px 11px", color: "#e6edf3", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" },
  btn: { width: "100%", padding: 10, background: "#22ff88", color: "#0d1117", border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" },
  btnOutline: (active) => ({ width: "100%", padding: 9, background: active ? "#22ff8820" : "transparent", color: active ? "#22ff88" : "#8b949e", border: `1px solid ${active ? "#22ff8860" : "#30363d"}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }),
  status: (t) => ({ padding: "8px 11px", borderRadius: 6, fontSize: 11, marginTop: 4, lineHeight: 1.5, background: t === "success" ? "#1a3a2a" : t === "error" ? "#3a1a1a" : t === "warn" ? "#2a2a1a" : "#1a1f2a", color: t === "success" ? "#22ff88" : t === "error" ? "#ff5555" : t === "warn" ? "#ffdd44" : "#8b949e", border: `1px solid ${t === "success" ? "#22ff8840" : t === "error" ? "#ff555540" : t === "warn" ? "#ffdd4440" : "#30363d"}` }),
  infoBox: { background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginTop: 8, fontSize: 12 },
  infoRow: { display: "flex", justifyContent: "space-between", marginBottom: 4, color: "#8b949e", fontSize: 11 },
  infoVal: { color: "#e6edf3", fontWeight: 600 },
  exportBtn: { width: "100%", padding: 10, background: "transparent", color: "#22ff88", border: "1px solid #22ff8860", borderRadius: 8, fontFamily: "inherit", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer", marginTop: 4 },
  divider: { border: "none", borderTop: "1px solid #21262d", margin: "10px 0" },
  resetBtn: { width: "100%", padding: 8, background: "transparent", color: "#8b949e", border: "1px solid #30363d", borderRadius: 6, fontFamily: "inherit", fontSize: 11, cursor: "pointer", marginTop: 2 },
  importBtn: { width: "100%", padding: 10, background: "transparent", color: "#ffdd44", border: "1px solid #ffdd4460", borderRadius: 8, fontFamily: "inherit", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer", marginTop: 2 },
  attemptRow: (ok) => ({ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "2px 0", color: ok ? "#22ff88" : "#8b949e" }),
  coordBadge: { background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: "7px 10px", fontSize: 10, color: "#8b949e", wordBreak: "break-word", lineHeight: 1.4 },
  coordBadgeSet: { background: "#0d1117", border: "1px solid #22ff8840", borderRadius: 6, padding: "7px 10px", fontSize: 10, color: "#e6edf3", wordBreak: "break-word", lineHeight: 1.4 },
  searchRow: { display: "flex", gap: 6, marginBottom: 2 },
};

// ─── MapView ──────────────────────────────────────────────────────────────────
const MapViewInner = function MapView({
  routeGeoJson, startCoord, endCoord, waypoints,
  onWaypointDrag, onWaypointDelete, onRouteClick, isRerouting,
  clickMode, onMapClick, flyTarget, showArrows, onToggleArrows,
  elevationData, showElevationChart, onToggleElevationChart,
  isMobile,
}) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const routeLayerRef = useRef(null);
  const arrowMarkersRef = useRef([]);
  const markerLayersRef = useRef([]);
  const wpMarkersRef = useRef([]);
  const hoverMarkerRef = useRef(null);
  const lastFlyTargetRef = useRef(null);
  const [zoom, setZoom] = useState(12);
  const [hoverChartIdx, setHoverChartIdx] = useState(null);
  const chartSvgRef = useRef(null);
  const [chartW, setChartW] = useState(340);

  // Refs for callbacks to avoid stale closures in Leaflet event handlers
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onRouteClickRef = useRef(onRouteClick);
  onRouteClickRef.current = onRouteClick;
  const onWaypointDragRef = useRef(onWaypointDrag);
  onWaypointDragRef.current = onWaypointDrag;
  const onWaypointDeleteRef = useRef(onWaypointDelete);
  onWaypointDeleteRef.current = onWaypointDelete;

  // Init map (runs once)
  useEffect(() => {
    if (!mapRef.current || !window.L || mapInstanceRef.current) return;
    const L = window.L;
    const map = L.map(mapRef.current, { zoomControl: true }).setView([-6.2, 106.8], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap", maxZoom: 19,
    }).addTo(map);

    // Use stable wrapper that reads from ref — never stale
    map.on("click", (e) => {
      onMapClickRef.current([e.latlng.lng, e.latlng.lat]);
    });

    // Track zoom changes so arrows can adjust spacing
    map.on("zoomend", () => setZoom(map.getZoom()));

    mapInstanceRef.current = map;
  }, []);

  // ── Fly to search target (only on external change, NOT on user pan) ──
  useEffect(() => {
    if (!mapInstanceRef.current || !flyTarget) return;
    // Compare serialized coords to avoid re-flying to same spot
    const key = `${flyTarget[0].toFixed(6)},${flyTarget[1].toFixed(6)}`;
    if (lastFlyTargetRef.current === key) return;
    lastFlyTargetRef.current = key;
    mapInstanceRef.current.flyTo([flyTarget[1], flyTarget[0]], 14, { duration: 1.2 });
  }, [flyTarget]);

  // ── Hover-to-locate: place a dot on the map when user hovers the elevation chart ──
  useEffect(() => {
    const L = window.L;
    const map = mapInstanceRef.current;
    if (!L || !map) return;

    if (hoverMarkerRef.current) { map.removeLayer(hoverMarkerRef.current); hoverMarkerRef.current = null; }

    if (showElevationChart && hoverChartIdx != null && routeGeoJson) {
      const coords = routeGeoJson.features[0].geometry.coordinates;
      if (coords && hoverChartIdx >= 0 && hoverChartIdx < coords.length) {
        const coord = coords[hoverChartIdx];
        if (coord && coord.length >= 2) {
          const [lon, lat] = coord;
          hoverMarkerRef.current = L.circleMarker([lat, lon], {
            radius: 8, color: "#ff4444", weight: 3, fillColor: "#ff4444", fillOpacity: 1,
            zIndexOffset: 2000,
          }).addTo(map);
        }
      }
    }
  }, [hoverChartIdx, showElevationChart, routeGeoJson]);

  // ── Track SVG chart actual width for responsive viewBox ──
  useEffect(() => {
    const el = chartSvgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(286, Math.round(entry.contentRect.width));
      setChartW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showElevationChart]);

  // Draw route line + directional arrows
  useEffect(() => {
    const L = window.L;
    if (!L || !mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    // Remove old route
    if (routeLayerRef.current) { map.removeLayer(routeLayerRef.current); routeLayerRef.current = null; }
    // Remove old arrows
    arrowMarkersRef.current.forEach(m => map.removeLayer(m));
    arrowMarkersRef.current = [];

    if (routeGeoJson) {
      const coords = routeGeoJson.features[0].geometry.coordinates;

      // ── Draw route line (ALWAYS visible) ──
      const line = L.geoJSON(routeGeoJson, {
        style: { color: "#ff4444", weight: 5, opacity: 0.85 }
      });

      line.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        onRouteClickRef.current([e.latlng.lng, e.latlng.lat]);
      });

      line.addTo(map);
      routeLayerRef.current = line;

      // ── Draw directional arrows (only when toggled on) ──
      if (showArrows) {

        // ── Draw directional arrows — spacing adapts to zoom level ──
        // Zoom  9-: 1000m  |  Zoom 10: 800m | Zoom 11: 500m | Zoom 13: 200m | Zoom 15+: 100m
        let arrowSpacingM = 100;
        if (zoom <= 9) arrowSpacingM = 1000;
        else if (zoom <= 10) arrowSpacingM = 800;
        else if (zoom <= 11) arrowSpacingM = 500;
        else if (zoom <= 12) arrowSpacingM = 300;
        else if (zoom <= 13) arrowSpacingM = 200;
        else if (zoom <= 14) arrowSpacingM = 150;
        // else zoom >= 15: 100m (default)
        let accumulated = 0;
        let lastPlacedIdx = 0;
        let totalDist = 0; // cumulative real distance for labeling
        let arrowNum = 0;

        for (let i = 1; i < coords.length; i++) {
          const segDist = haversine(coords[i - 1], coords[i]);
          totalDist += segDist;
          accumulated += segDist;

          if (accumulated >= arrowSpacingM && i > lastPlacedIdx) {
            arrowNum++;
            // Interpolate exact position on this segment so arrow sits ON the line
            const overshoot = accumulated - arrowSpacingM; // how far past threshold we are
            const t = 1 - overshoot / segDist; // fraction along [i-1, i]
            const [lon1, lat1] = coords[i - 1];
            const [lon2, lat2] = coords[i];
            const lon = lon1 + (lon2 - lon1) * t;
            const lat = lat1 + (lat2 - lat1) * t;
            // Use this specific segment's bearing so arrow points along the road
            const angle = bearing(coords[i - 1], coords[i]);
            const distKm = ((totalDist - accumulated + arrowSpacingM) / 1000).toFixed(1);

            const arrowIcon = L.divIcon({
              className: "",
              html: `<div style="text-align:center;width:28px;height:34px;margin-left:-14px;margin-top:-17px;">
              <div style="
                width:0;height:0;margin:0 auto 1px;transform:rotate(${angle}deg);
                border-left:6px solid transparent;
                border-right:6px solid transparent;
                border-bottom:16px solid #ffdd00;
                filter:drop-shadow(0 0 4px #000c) drop-shadow(0 1px 2px #000);
              "></div>
              <div style="
                font-size:9px;font-weight:800;font-family:monospace;
                color:#0d1117;background:#ffdd00;border-radius:3px;
                padding:1px 3px;line-height:1;display:inline-block;
                box-shadow:0 1px 3px #0008;
              ">${distKm}</div>
            </div>`,
              iconSize: [28, 34],
              iconAnchor: [14, 17],
            });

            const arrowMarker = L.marker([lat, lon], {
              icon: arrowIcon,
              interactive: false,
              zIndexOffset: 300,
            }).addTo(map);

            arrowMarkersRef.current.push(arrowMarker);
            accumulated -= arrowSpacingM;
            lastPlacedIdx = i;
          }
        }
      } // end if (showArrows)

      // Only fitBounds on first route draw — not when startCoord is already set
      if (!startCoord) map.fitBounds(line.getBounds(), { padding: [30, 30] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeGeoJson, zoom, showArrows]);

  // Draw start/end markers
  useEffect(() => {
    const L = window.L;
    if (!L || !mapInstanceRef.current) return;
    const map = mapInstanceRef.current;
    markerLayersRef.current.forEach(m => map.removeLayer(m));
    markerLayersRef.current = [];

    const pinIcon = (label, color = "#22ff88") => L.divIcon({
      className: "",
      html: `<div style="width:80px; background:${color};color:#0d1117;font-weight:800;font-family:monospace;padding:4px 8px;border-radius:5px;font-size:11px;white-space:nowrap;box-shadow:0 2px 8px #0006;border:2px solid #0d111740">${label}</div>`,
      iconAnchor: [0, 0],
    });

    if (startCoord) {
      const m = L.marker([startCoord[1], startCoord[0]], { icon: pinIcon("▶ START"), zIndexOffset: 1000 }).addTo(map);
      markerLayersRef.current.push(m);
    }
    if (endCoord) {
      const m = L.marker([endCoord[1], endCoord[0]], { icon: pinIcon("⚑ FINISH", "#ff8844"), zIndexOffset: 1000 }).addTo(map);
      markerLayersRef.current.push(m);
    }
  }, [startCoord, endCoord]);

  // Draw draggable waypoint handles — uses refs so dep array stays clean
  useEffect(() => {
    const L = window.L;
    if (!L || !mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    wpMarkersRef.current.forEach(m => map.removeLayer(m));
    wpMarkersRef.current = [];

    waypoints.forEach((wp, idx) => {
      const handle = L.divIcon({
        className: "",
        html: `<div class="wp-handle" data-idx="${idx}" title="Drag to reshape • Double-click to delete" style="
          width:16px;height:16px;background:#fff;border:3px solid #ff4444;
          border-radius:50%;cursor:grab;box-shadow:0 2px 8px #0008;
          transition:transform 0.1s;
        "></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      });

      const marker = L.marker([wp[1], wp[0]], {
        icon: handle, draggable: true, zIndexOffset: 500,
      });

      marker.on("dragend", (e) => {
        const { lat, lng } = e.target.getLatLng();
        onWaypointDragRef.current(idx, [lng, lat]);
      });

      marker.on("contextmenu", (e) => {
        L.DomEvent.stopPropagation(e);
        onWaypointDeleteRef.current(idx);
      });

      // Double-click to delete — works on mobile where right-click doesn't exist
      marker.on("dblclick", (e) => {
        L.DomEvent.stopPropagation(e);
        onWaypointDeleteRef.current(idx);
      });

      marker.bindTooltip(`Waypoint ${idx + 1}<br><span style="opacity:.6;font-size:10px">Drag · Dbl-click delete</span>`, {
        direction: "top", offset: [0, -10],
      });

      marker.addTo(map);
      wpMarkersRef.current.push(marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
      {clickMode && (
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
          background: "#161b22ee", border: "1px solid #22ff8860", borderRadius: 8,
          padding: "8px 16px", fontSize: 12, color: "#22ff88", fontFamily: "monospace",
          letterSpacing: 1, zIndex: 1000, pointerEvents: "none",
        }}>
          ● Click on map to set <strong>{clickMode === "start" ? "START" : "FINISH"}</strong> point
        </div>
      )}
      {isRerouting && (
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
          background: "#161b22ee", border: "1px solid #22ff8860", borderRadius: 8,
          padding: "8px 16px", fontSize: 12, color: "#22ff88", fontFamily: "monospace",
          letterSpacing: 1, zIndex: 1000, pointerEvents: "none",
        }}>⟳ Recalculating route...</div>
      )}
      {!isRerouting && routeGeoJson &&!isMobile&& (
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
          background: "#161b22cc", border: "1px solid #30363d", borderRadius: 8,
          padding: "7px 14px", fontSize: 11, color: "#8b949e", fontFamily: "monospace",
          zIndex: 1000, pointerEvents: "none", whiteSpace: "nowrap",
        }}>· Click route to add point &nbsp;|&nbsp; Drag white dots to reshape &nbsp;|&nbsp; Double-click dot to delete</div>
      )}

      {/* Elevation Toggle — chart is shown as map overlay */}
      {!isRerouting && routeGeoJson && !isMobile && (
        <button
          onClick={() => elevationData && elevationData.length > 1 && onToggleElevationChart()}
          disabled={!elevationData || elevationData.length < 2}
          style={{
          position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
            padding: "7px 14px",
            zIndex:1000,
            background: showElevationChart ? "#22ff8818" : "#161b22ee",
            color: showElevationChart ? "#22ff88" : (!elevationData || elevationData.length < 2 ? "#30363d" : "#8b949e"),
            border: `1px solid ${showElevationChart ? "#22ff8840" : "#30363d"}`,
            borderRadius: 8, fontFamily: "inherit", fontSize: 11, fontWeight: 600,
            cursor: (!elevationData || elevationData.length < 2) ? "not-allowed" : "pointer",
            transition: "all 0.15s",
          }}
        >
          📈 Elevation {showElevationChart ? "▼" : "▲"} &nbsp;
          <span style={{ color: elevationData && elevationData.length > 1 ? "#e6edf3" : "#30363d" }}>
            {elevationData && elevationData.length > 1
              ? `${Math.round(elevationData[0].ele)}–${Math.round(elevationData[elevationData.length - 1].ele)} m · ▲${Math.round(Math.max(...elevationData.map(p => p.ele)) - Math.min(...elevationData.map(p => p.ele)))} m gain`
              : "No elevation data"}
          </span>
        </button>
      )}
      {routeGeoJson && (
        <button
          onClick={onToggleArrows}
          style={{
            position: "absolute", top: 16, right: 16,
            background: "#161b22ee", border: "1px solid #ffdd4460", borderRadius: 8,
            padding: "6px 12px", fontSize: 11, color: "#ffdd44", fontFamily: "monospace",
            letterSpacing: 1, zIndex: 1000, cursor: "pointer",
          }}
        >
          {showArrows ? "⇩ Hide Arrows" : "⇧ Show Arrows"}
        </button>
      )}
      {/* ── Elevation Chart Overlay ── */}
      {showElevationChart && elevationData && elevationData.length > 1 && routeGeoJson && (() => {
        const data = elevationData;
        const coords = routeGeoJson.features[0].geometry.coordinates;
        const minEle = Math.min(...data.map(p => p.ele));
        const maxEle = Math.max(...data.map(p => p.ele));
        const range = maxEle - minEle || 1;
        const totalDist = data[data.length - 1].distKm || 1;
        const H = 160, padL = 40, padR = 14, padT = 10, padB = 24;
        const W = chartW;
        const plotW = W - padL - padR;
        const plotH = H - padT - padB;

        const points = data.map((p, i) => {
          const x = padL + (p.distKm / totalDist) * plotW;
          const y = padT + plotH - ((p.ele - minEle) / range) * plotH;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        const areaPath = points + ` L${padL + plotW},${padT + plotH} L${padL},${padT + plotH} Z`;

        const yTicks = [];
        const yStep = Math.max(1, Math.round(range / 4));
        for (let v = Math.ceil(minEle); v <= maxEle; v += yStep) {
          const y = padT + plotH - ((v - minEle) / range) * plotH;
          if (y >= padT && y <= padT + plotH) yTicks.push({ v, y });
        }
        const xTicks = [];
        const xStep = totalDist > 10 ? 5 : totalDist > 5 ? 2 : 1;
        for (let d = 0; d <= totalDist; d += xStep) {
          xTicks.push({ d, x: padL + (d / totalDist) * plotW });
        }

        // Find closest data index for a given plot X position
        const idxForX = (px) => {
          const frac = Math.max(0, Math.min(1, (px - padL) / plotW));
          const dist = frac * totalDist;
          let best = 0;
          for (let i = 1; i < data.length; i++) {
            if (data[i].distKm >= dist) {
              best = (dist - data[i - 1].distKm) < (data[i].distKm - dist) ? i - 1 : i;
              break;
            }
            best = i;
          }
          return best;
        };

        const handleChartMove = (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const idx = idxForX(px);
          setHoverChartIdx(idx);
        };
        const handleChartLeave = () => setHoverChartIdx(null);

        // Hover cursor X position
        const cursorX = hoverChartIdx != null && data[hoverChartIdx]
          ? padL + (data[hoverChartIdx].distKm / totalDist) * plotW
          : null;

        return (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            background: "#161b22ee", border: "none", borderTop: "1px solid #22ff8860", borderRadius: 0,
            padding: "10px 12px 8px 12px", zIndex: 1001, boxShadow: "0 -4px 16px #000a",
            cursor: "crosshair",
          }}>
            <div style={{ fontSize: 10, color: "#22ff88", fontFamily: "monospace", letterSpacing: 2, textAlign: "center", marginBottom: 2 }}>
              ELEVATION PROFILE
              <button onClick={onToggleElevationChart} style={{
                marginLeft: 8, background: "none", border: "1px solid #30363d", borderRadius: 4,
                color: "#8b949e", fontSize: 10, cursor: "pointer", padding: "1px 6px",
              }}>✕</button>
            </div>
            <svg ref={chartSvgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
              onMouseMove={handleChartMove} onMouseLeave={handleChartLeave}
              style={{ display: "block", margin: "0 auto", borderRadius: 6 }}>
              {/* Grid lines */}
              {yTicks.filter(t => t && !isNaN(t.y)).map(t => (
                <line key={`yg${t.v}`} x1={padL} y1={t.y} x2={padL + plotW} y2={t.y} stroke="#21262d" strokeWidth="0.5" />
              ))}
              <path d={areaPath} fill="#22ff8820" stroke="none" />
              <path d={points} fill="none" stroke="#22ff88" strokeWidth="2" strokeLinejoin="round" />
              {yTicks.filter(t => t && !isNaN(t.y)).map(t => (
                <text key={`yl${t.v}`} x={padL - 5} y={t.y + 4} textAnchor="end" fill="#8b949e" fontSize="16" fontFamily="monospace">{t.v}</text>
              ))}
              {xTicks.filter(t => t && t.x != null && !isNaN(t.x)).map(t => (
                <text key={`xl${t.d}`} x={t.x} y={H - 4} textAnchor="middle" fill="#8b949e" fontSize="16" fontFamily="monospace">{t.d}</text>
              ))}
              <text x={10} y={padT + plotH / 2} textAnchor="middle" fill="#30363d" fontSize="16" fontFamily="monospace" transform={`rotate(-90,10,${padT + plotH / 2})`}>m</text>
              <text x={padL + plotW / 2} y={H - 1} textAnchor="middle" fill="#30363d" fontSize="16" fontFamily="monospace">km</text>
              {data[0] && (
                <circle cx={padL} cy={padT + plotH - ((data[0].ele - minEle) / range) * plotH} r="3" fill="#e6edf3" stroke="#0d1117" strokeWidth="1" />
              )}
              {data[data.length - 1] && (
                <circle cx={padL + plotW} cy={padT + plotH - ((data[data.length - 1].ele - minEle) / range) * plotH} r="3" fill="#22ff88" stroke="#0d1117" strokeWidth="1" />
              )}
              {/* Hover cursor */}
              {cursorX != null && hoverChartIdx != null && data[hoverChartIdx] && (
                <>
                  <line x1={cursorX} y1={padT} x2={cursorX} y2={padT + plotH} stroke="#ff4444" strokeWidth="2" strokeDasharray="4 2" />
                  <circle cx={cursorX} cy={padT + plotH - ((data[hoverChartIdx].ele - minEle) / range) * plotH} r="5" fill="#ff4444" stroke="#0d1117" strokeWidth="2" />
                  {/* Hover tooltip */}
                  <rect x={cursorX > padL + plotW / 2 ? cursorX - 70 : cursorX + 10} y={padT} width="64" height="40" rx="4" fill="#0d1117ee" stroke="#ff444460" />
                  <text x={cursorX > padL + plotW / 2 ? cursorX - 38 : cursorX + 38} y={padT + 16} textAnchor="middle" fill="#ff4444" fontSize="16" fontFamily="monospace">{data[hoverChartIdx].distKm.toFixed(1)} km</text>
                  <text x={cursorX > padL + plotW / 2 ? cursorX - 38 : cursorX + 38} y={padT + 33} textAnchor="middle" fill="#e6edf3" fontSize="16" fontFamily="monospace">{Math.round(data[hoverChartIdx].ele)} m</text>
                </>
              )}
            </svg>
          </div>
        );
      })()}
    </div>
  );
};

const MapView = React.memo(MapViewInner, (prev, next) => {
  // Only re-render if these specific props actually changed values
  const keys = ["routeGeoJson", "startCoord", "endCoord", "waypoints", "isRerouting", "clickMode", "flyTarget", "showArrows", "elevationData", "showElevationChart", "isMobile"];
  const changed = keys.filter(k => prev[k] !== next[k]);
  if (changed.length > 0) {
    return false; // props changed, re-render
  }
  return true; // skip re-render
});

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [form, setForm] = useState({ distance: "", margin: "0.5" });
  const [searchQuery, setSearchQuery] = useState("");
  const [startCoord, setStartCoord] = useState(null);
  const [endCoord, setEndCoord] = useState(null);
  const [startLabel, setStartLabel] = useState("");
  const [endLabel, setEndLabel] = useState("");
  const [waypoints, setWaypoints] = useState([]);
  const [route, setRoute] = useState(null);
  const [routeInfo, setRouteInfo] = useState(null);
  const [elevationData, setElevationData] = useState(null);
  const [showElevationChart, setShowElevationChart] = useState(false);
  const [status, setStatus] = useState({ type: "idle", msg: "" });
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const [isRerouting, setIsRerouting] = useState(false);
  const [attempts, setAttempts] = useState([]);
  const [altRoutes, setAltRoutes] = useState([]); // [{geojson, distKm, offsetM, ...}]
  const [altIdx, setAltIdx] = useState(0);
  const [clickMode, setClickMode] = useState(null); // "start" | "end" | null
  const [flyTarget, setFlyTarget] = useState(null);  // only set by search — never by map pan
  const [showArrows, setShowArrows] = useState(false);
  const [profile, setProfile] = useState("driving-car");

  const rerouteTimer = useRef(null);
  const fileInputRef = useRef(null);
  const startCoordRef = useRef(null);
  const endCoordRef = useRef(null);
  const clickModeRef = useRef(clickMode);

  useEffect(() => { startCoordRef.current = startCoord; }, [startCoord]);
  useEffect(() => { endCoordRef.current = endCoord; }, [endCoord]);
  useEffect(() => { clickModeRef.current = clickMode; }, [clickMode]);

  // ─── GPX Import ─────────────────────────────────────────────────────────────
  const handleImportGPX = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so same file can be re-imported

    setStatus({ type: "loading", msg: "Importing GPX file..." });
    try {
      const text = await file.text();
      const result = parseGPX(text);

      setRoute(result.geojson);
      const gpxElev = extractElevationProfile(result.geojson);
      setElevationData(gpxElev);
      if (!gpxElev || gpxElev.length < 2) setShowElevationChart(false);
      setStartCoord(result.startCoord);
      setEndCoord(result.endCoord);
      const intermedCoords = sampleIntermediateWaypoints(result.geojson, Math.min(3, result.waypointCount > 10 ? 3 : 1));
      setWaypoints(intermedCoords);
      setRouteInfo({ distKm: result.distanceKm, ok: true, targetKm: "-", marginKm: "-" });
      setStatus({ type: "success", msg: `✓ Imported GPX: ${result.distanceKm} km (${result.waypointCount} points)` });

      // Derive labels
      try {
        const sl = await reverseGeocode(result.startCoord[1], result.startCoord[0]);
        setStartLabel(sl);
      } catch { setStartLabel(`${result.startCoord[1].toFixed(4)}, ${result.startCoord[0].toFixed(4)}`); }
      try {
        const el = await reverseGeocode(result.endCoord[1], result.endCoord[0]);
        setEndLabel(el);
      } catch { setEndLabel(`${result.endCoord[1].toFixed(4)}, ${result.endCoord[0].toFixed(4)}`); }

      // Fly map to the imported route midpoint
      const midLon = result.startCoord[0] + (result.endCoord[0] - result.startCoord[0]) / 2;
      const midLat = result.startCoord[1] + (result.endCoord[1] - result.startCoord[1]) / 2;
      setFlyTarget([midLon, midLat]);
    } catch (err) {
      setStatus({ type: "error", msg: `GPX import failed: ${err.message}` });
    }
  }, []);

  // Load Leaflet
  useEffect(() => {
    if (window.L) { setLeafletLoaded(true); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => setLeafletLoaded(true);
    document.head.appendChild(script);
  }, []);

  const handleChange = e => setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  // ─── Map Search ─────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setStatus({ type: "loading", msg: "Searching location..." });
    try {
      const coord = await geocode(searchQuery);
      setFlyTarget([coord[0], coord[1]]);
      setStatus({ type: "idle", msg: "" });
    } catch (e) {
      setStatus({ type: "error", msg: e.message });
    }
  }, [searchQuery]);

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter") handleSearch();
  };

  // ─── Map Click Handler — stable reference via ref ───────────────────────────
  const handleMapClick = useCallback(async (coord) => {
    const mode = clickModeRef.current; // read from ref, not state closure
    if (mode === "start") {
      setStartCoord(coord);
      setClickMode(null);
      try {
        const label = await reverseGeocode(coord[1], coord[0]);
        setStartLabel(label);
      } catch { setStartLabel(`${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`); }
    } else if (mode === "end") {
      setEndCoord(coord);
      setClickMode(null);
      try {
        const label = await reverseGeocode(coord[1], coord[0]);
        setEndLabel(label);
      } catch { setEndLabel(`${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`); }
    }
  }, []); // empty dep — uses ref, always stable

  // ─── Routing ────────────────────────────────────────────────────────────────
  const rerouteWith = useCallback(async (wps, sCoord, eCoord) => {
    if (!sCoord || !eCoord) return;
    setIsRerouting(true);
    try {
      const allCoords = [sCoord, ...wps, eCoord].map(c => c.length > 2 ? [c[0], c[1]] : c);
      const geojson = await getRoute(allCoords, profile);
      const distKm = routeDistanceKm(geojson).toFixed(2);
      const targetM = parseFloat(form.distance) * 1000;
      const marginM = parseFloat(form.margin || 0) * 1000;
      const dist = parseFloat(distKm) * 1000;
      const ok = dist >= targetM - marginM && dist <= targetM + marginM;
      setRoute(geojson);
      const elev = extractElevationProfile(geojson);
      setElevationData(elev);
      if (!elev || elev.length < 2) setShowElevationChart(false);
      setRouteInfo(ri => ({ ...ri, distKm, ok }));
      setStatus({
        type: ok ? "success" : "warn",
        msg: ok ? `✓ Route: ${distKm} km` : `Route: ${distKm} km (target ${form.distance} km ± ${form.margin} km)`,
      });
    } catch (e) {
      setStatus({ type: "error", msg: e.message });
    } finally {
      setIsRerouting(false);
    }
  }, [form.distance, form.margin, profile]);

  const debouncedReroute = useCallback((newWps) => {
    clearTimeout(rerouteTimer.current);
    rerouteTimer.current = setTimeout(() => {
      rerouteWith(newWps, startCoordRef.current, endCoordRef.current);
    }, 400);
  }, [rerouteWith]);

  const handleWaypointDrag = useCallback((idx, newCoord) => {
    setWaypoints(prev => {
      const next = prev.map((wp, i) => i === idx ? newCoord : wp);
      debouncedReroute(next);
      return next;
    });
  }, [debouncedReroute]);

  const handleWaypointDelete = useCallback((idx) => {
    setWaypoints(prev => {
      const next = prev.filter((_, i) => i !== idx);
      debouncedReroute(next);
      return next;
    });
  }, [debouncedReroute]);

  const handleRouteClick = useCallback((coord) => {
    setWaypoints(prev => {
      const allPts = [startCoordRef.current, ...prev, endCoordRef.current];
      let bestIdx = 1, bestDist = Infinity;
      for (let i = 0; i < allPts.length - 1; i++) {
        if (!allPts[i] || !allPts[i + 1]) continue;
        const d = haversine(allPts[i], coord) + haversine(coord, allPts[i + 1]);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const next = [...prev.slice(0, bestIdx), coord, ...prev.slice(bestIdx)];
      // Do NOT reroute on click — just add the waypoint. Reroute happens on drag.
      return next;
    });
  }, []);

  // Initial route search — uses real road coordinates for natural-looking detours
  const findRoute = useCallback(async () => {
    const { distance, margin } = form;
    if (!distance || !startCoord || !endCoord) {
      setStatus({ type: "error", msg: "Set start & end points on the map and enter distance!" }); return;
    }
    const targetM = parseFloat(distance) * 1000;
    const marginM = parseFloat(margin || 0) * 1000;
    const minM = targetM - marginM, maxM = targetM + marginM;

    setStatus({ type: "loading", msg: "Getting direct road route..." });
    setRoute(null); setWaypoints([]); setAttempts([]); setAltRoutes([]); setAltIdx(0); setElevationData(null); setShowElevationChart(false);

    const prevStart = startCoord, prevEnd = endCoord;

    try {
      // Step 1: Get the direct walking route (follows actual roads)
      setStatus({ type: "loading", msg: "Requesting direct route from OSRM..." });
      const directGeoJson = await getRoute([prevStart, prevEnd], profile);
      const directCoords = directGeoJson.features[0].geometry.coordinates;
      const directDist = directGeoJson.features[0].properties.summary.distance;

      const log = [];
      log.push({ attempt: 0, dist: (directDist / 1000).toFixed(2), ok: directDist >= minM && directDist <= maxM });

      // Collect ALL alternative routes (not just the closest one)
      const allAlts = [];
      allAlts.push({
        geojson: directGeoJson, distKm: (directDist / 1000).toFixed(2),
        distM: directDist, offsetM: 0,
        ok: directDist >= minM && directDist <= maxM,
      });

      // Need detours if direct route is too short or too long
      const needLonger = directDist < minM;

      // Step 2: One-way detours — offsets to both sides, finer granularity
      const sideSets = [1, -1]; // right side (1), then left side (-1)
      const baseOffsets = needLonger
        ? [50, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500, 1800, 2200, 2600, 3000]
        : [50, 100, 150, 200, 300, 400, 500, 600, 800];

      // Try all side + offset combinations (collect everything)
      const tried = new Set();
      for (const side of sideSets) {
        for (const off of baseOffsets) {
          const key = `${side}:${off}`;
          if (tried.has(key)) continue;
          tried.add(key);
          const attemptNum = log.length;
          const sideLabel = side === 1 ? "right" : "left";
          setStatus({ type: "loading", msg: `Trying ${sideLabel} detour ${off}m... attempt ${attemptNum}` });
          try {
            const wps = buildOneWayDetour(directCoords, off, 3, side);
            const geojson = await getRoute(wps, profile);
            const dist = geojson.features[0].properties.summary.distance;
            const diff = Math.abs(dist - targetM);
            const ok = dist >= minM && dist <= maxM;
            const pctOff = diff / targetM;
            log.push({ attempt: attemptNum, dist: (dist / 1000).toFixed(2), ok });
            // Only collect if within 25% of target (tight filter)
            if (pctOff < 0.25) {
              allAlts.push({
                geojson, distKm: (dist / 1000).toFixed(2),
                distM: dist, offsetM: off * side,
                ok, pctOff: Math.round(pctOff * 100),
              });
            }
          } catch (e) {
            log.push({ attempt: attemptNum, dist: "err", ok: false });
          }
        }
      }

      // Interpolation: if at least 2 results, find "sweet spot" offset
      if (allAlts.length >= 2) {
        const below = allAlts.filter(a => a.distM < targetM).sort((a, b) => b.distM - a.distM);
        const above = allAlts.filter(a => a.distM >= targetM).sort((a, b) => a.distM - b.distM);
        if (below.length > 0 && above.length > 0) {
          const lo = below[0], hi = above[0];
          if (hi.distM !== lo.distM) {
            const frac = (targetM - lo.distM) / (hi.distM - lo.distM);
            const interpOffset = Math.round(lo.offsetM + frac * (hi.offsetM - lo.offsetM));
            const absInterp = Math.abs(interpOffset);
            const interpKey = `${interpOffset > 0 ? 1 : -1}:${absInterp}`;
            if (!tried.has(interpKey) && absInterp >= 50 && absInterp <= 5000) {
              tried.add(interpKey);
              const interpSide = interpOffset >= 0 ? 1 : -1;
              setStatus({ type: "loading", msg: `Trying interpolated detour at ${interpOffset}m...` });
              try {
                const wps = buildOneWayDetour(directCoords, absInterp, 3, interpSide);
                const geojson = await getRoute(wps, profile);
                const dist = geojson.features[0].properties.summary.distance;
                const diff = Math.abs(dist - targetM);
                const ok = dist >= minM && dist <= maxM;
                log.push({ attempt: log.length, dist: (dist / 1000).toFixed(2), ok });
                const pctOff = diff / targetM;
                if (pctOff < 0.25) {
                  allAlts.push({
                    geojson, distKm: (dist / 1000).toFixed(2),
                    distM: dist, offsetM: interpOffset,
                    ok, pctOff: Math.round(pctOff * 100),
                  });
                }
              } catch (e) {
                log.push({ attempt: log.length, dist: "err", ok: false });
              }
            }
          }
        }
      }

      // Sort alternatives: closest-to-target first, then by distance
      allAlts.sort((a, b) => {
        const diffA = Math.abs(a.distM - targetM);
        const diffB = Math.abs(b.distM - targetM);
        if (diffA !== diffB) return diffA - diffB;
        return Math.abs(a.offsetM) - Math.abs(b.offsetM);
      });

      setAttempts(log);
      setAltRoutes(allAlts);
      setAltIdx(0);

      const best = allAlts[0];
      const intermedCoords = sampleIntermediateWaypoints(best.geojson, 3);
      setWaypoints(intermedCoords);
      setRoute(best.geojson);
      setElevationData(extractElevationProfile(best.geojson));
      setRouteInfo({ distKm: best.distKm, ok: best.ok, targetKm: parseFloat(distance), marginKm: parseFloat(margin || 0) });
      setStatus({
        type: best.ok ? "success" : "warn",
        msg: best.ok
          ? `✓ Route found: ${best.distKm} km (${allAlts.length} alternatives)`
          : `Best route: ${best.distKm} km (${allAlts.length} alternatives, outside margin ±${margin} km)`,
      });
    } catch (e) {
      setStatus({ type: "error", msg: e.message || "Failed to find route. Try a different distance." });
    }
  }, [form, startCoord, endCoord, profile]);

  // ─── Cycle to next alternative route ────────────────────────────────────────
  const nextAlternative = useCallback(() => {
    if (altRoutes.length <= 1) return;
    const nextIdx = (altIdx + 1) % altRoutes.length;
    setAltIdx(nextIdx);
    const alt = altRoutes[nextIdx];
    setRoute(alt.geojson);
    const elev = extractElevationProfile(alt.geojson);
    setElevationData(elev);
    if (!elev || elev.length < 2) setShowElevationChart(false);
    const intermedCoords = sampleIntermediateWaypoints(alt.geojson, 3);
    setWaypoints(intermedCoords);
    setRouteInfo(ri => ({
      ...ri,
      distKm: alt.distKm,
      ok: alt.ok,
    }));
    setStatus({
      type: alt.ok ? "success" : "warn",
      msg: alt.ok
        ? `✓ Alternative ${nextIdx + 1}/${altRoutes.length}: ${alt.distKm} km (offset ${alt.offsetM}m)`
        : `⚠ Alternative ${nextIdx + 1}/${altRoutes.length}: ${alt.distKm} km (offset ${alt.offsetM}m, outside margin)`,
    });
  }, [altRoutes, altIdx]);

  const [panelOpen, setPanelOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isLoading = status.type === "loading";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        input:focus { border-color:#22ff88!important; }
        button:hover:not(:disabled) { opacity:.85; }
        ::-webkit-scrollbar { width:4px; } ::-webkit-scrollbar-track { background:#0d1117; } ::-webkit-scrollbar-thumb { background:#30363d; }
        .leaflet-container { background:#161b22!important; }
        .wp-handle:hover { transform:scale(1.4)!important; }
        .leaflet-interactive { cursor:pointer!important; }
        /* ── Mobile responsive ── */
        @media (max-width: 768px) {
          .app-root { flex-direction: column!important; }
          .app-panel {
            width: 100%!important; min-width: 0!important; max-height: 45vh;
            border-right: none!important; border-top: 1px solid #21262d!important;
            transition: max-height 0.3s ease, padding 0.3s ease;
            overflow-y: auto!important;
          }
          .app-panel.collapsed { max-height: 0!important; padding-top: 0!important; padding-bottom: 0!important; overflow: hidden!important; border-top: none!important; }
          .app-map { min-height: 55vh; }
          .mobile-toggle {
            display: flex!important;
            width: 100%; justify-content: center; align-items: center;
            background: #161b22; color: #22ff88;
            border: none; border-top: 1px solid #22ff8860; border-bottom: 1px solid #22ff8860;
            padding: 10px 18px; font-size: 12px; font-family: monospace;
            letter-spacing: 1px; cursor: pointer; white-space: nowrap;
            flex-shrink: 0;
          }
        }
        @media (min-width: 769px) {
          .mobile-toggle { display: none!important; }
          .app-panel { max-height: none!important; }
        }
      `}</style>
      <div className="app-root" style={S.app}>
        {/* ── Panel ── */}
        <div className={`app-panel${isMobile && !panelOpen ? " collapsed" : ""}`} style={S.panel}>
          <div style={S.logo}>RunRoute</div>
          <div style={S.title}>Find & Edit Running Route</div>

          {/* Map Search */}
          <label style={S.label}>Search & Center Map</label>
          <div style={S.searchRow}>
            <input
              style={{ ...S.input, flex: 1 }}
              placeholder="Search city, landmark..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <button style={{ ...S.btn, width: 60, fontSize: 11 }} onClick={handleSearch} disabled={isLoading}>Go</button>
          </div>

          <hr style={S.divider} />

          {/* Set Start / End */}
          <label style={S.label}>1. Set Start Point</label>
          <button
            style={S.btnOutline(clickMode === "start")}
            onClick={() => setClickMode(m => m === "start" ? null : "start")}
          >
            {clickMode === "start" ? "● Clicking map for START..." : "▶ Set Start Point on Map"}
          </button>
          <div style={startCoord ? S.coordBadgeSet : S.coordBadge}>
            {startCoord ? `✓ ${startLabel || `${startCoord[1].toFixed(5)}, ${startCoord[0].toFixed(5)}`}` : "Click \"Set Start\" then click map"}
          </div>

          <label style={{ ...S.label, marginTop: 4 }}>2. Set Finish Point</label>
          <button
            style={S.btnOutline(clickMode === "end")}
            onClick={() => setClickMode(m => m === "end" ? null : "end")}
          >
            {clickMode === "end" ? "● Clicking map for FINISH..." : "⚑ Set Finish Point on Map"}
          </button>
          <div style={endCoord ? S.coordBadgeSet : S.coordBadge}>
            {endCoord ? `✓ ${endLabel || `${endCoord[1].toFixed(5)}, ${endCoord[0].toFixed(5)}`}` : "Click \"Set Finish\" then click map"}
          </div>

          <hr style={S.divider} />

          {/* Distance & Margin */}
          <label style={S.label}>3. Target Distance (km)</label>
          <input style={S.input} name="distance" placeholder="e.g. 10" value={form.distance} onChange={handleChange} type="number" min="0.5" step="0.5" />

          <label style={{ ...S.label, marginTop: 2 }}>4. Margin of Error (km)</label>
          <input style={S.input} name="margin" placeholder="e.g. 0.5" value={form.margin} onChange={handleChange} type="number" min="0" step="0.1" />

          {/* Route Profile */}
          <label style={{ ...S.label, marginTop: 4 }}>5. Route Profile</label>
          <select
            value={profile}
            onChange={e => setProfile(e.target.value)}
            style={{ ...S.input, cursor: "pointer" }}
          >
            <option value="driving-car">🚗 Driving (Car)</option>
            <option value="cycling-regular">🚴 Cycling</option>
            <option value="cycling-mountain">⛰️ Mountain Bike</option>
            <option value="foot-walking">🚶 Walking / Running</option>
            <option value="foot-hiking">🥾 Hiking</option>
          </select>

          {/* Find Route */}
          <button style={{ ...S.btn, marginTop: 10, opacity: isLoading ? 0.5 : 1 }} onClick={findRoute} disabled={isLoading || !startCoord || !endCoord}>
            {isLoading ? "⏳ Searching..." : "🔍 Find Route"}
          </button>

          {/* Status */}
          {status.type !== "idle" && <div style={S.status(status.type)}>{status.msg}</div>}

          {/* Route Info */}
          {routeInfo && (
            <div style={S.infoBox}>
              <div style={S.infoRow}>
                <span>Route distance</span>
                <span style={{ ...S.infoVal, color: routeInfo.ok ? "#22ff88" : "#ffdd44" }}>{routeInfo.distKm} km</span>
              </div>
              <div style={S.infoRow}>
                <span>Target</span>
                <span style={S.infoVal}>{routeInfo.targetKm} ± {routeInfo.marginKm} km</span>
              </div>
              <div style={S.infoRow}>
                <span>Waypoints</span>
                <span style={S.infoVal}>{waypoints.length} adjustable points</span>
              </div>
              <div style={S.infoRow}>
                <span>Status</span>
                <span style={{ ...S.infoVal, color: routeInfo.ok ? "#22ff88" : "#ffdd44" }}>
                  {routeInfo.ok ? "✓ Within range" : "⚠ Outside margin"}
                </span>
              </div>
            </div>
          )}

          {/* Find Another Route — cycle through alternatives */}
          {altRoutes.length > 1 && (
            <button
              onClick={nextAlternative}
              disabled={isLoading}
              style={{
                width: "100%", padding: 8, marginTop: 4,
                background: "#ffdd4418",
                color: "#ffdd44",
                border: "1px solid #ffdd4440",
                borderRadius: 8, fontFamily: "inherit", fontSize: 11, fontWeight: 600,
                cursor: isLoading ? "not-allowed" : "pointer",
                transition: "all 0.15s",
              }}
            >
              🔄 Next Route ({altIdx + 1}/{altRoutes.length}) — {altRoutes[altIdx].distKm} km {altRoutes[altIdx].offsetM !== 0 ? `(detour ${altRoutes[altIdx].offsetM > 0 ? "+" : ""}${altRoutes[altIdx].offsetM}m)` : "(direct)"}
            </button>
          )}


          {/* Reset Waypoints
          {route && waypoints.length > 0 && (
            <button style={S.resetBtn} onClick={() => {
              const wps = sampleIntermediateWaypoints(route, 3);
              setWaypoints(wps);
            }}>
              ↺ Reset waypoints to default
            </button>
          )} */}

          {/* Export GPX */}
          {route && (
            <button style={S.exportBtn} onClick={() => exportGPX(route, routeInfo.distKm)}>
              ↓ Export GPX
            </button>
          )}

          {/* Import GPX */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpx"
            style={{ display: "none" }}
            onChange={handleImportGPX}
          />
          <button style={S.importBtn} onClick={() => fileInputRef.current?.click()}>
            ↑ Import GPX
          </button>

          {/* Attempt Log
          {attempts.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <hr style={S.divider} />
              <div style={{ fontSize: 10, letterSpacing: 2, color: "#30363d", textTransform: "uppercase", marginBottom: 4 }}>Search Log</div>
              {attempts.map((a, i) => (
                <div key={i} style={S.attemptRow(a.ok)}>
                  <span>Attempt {a.attempt}</span>
                  <span>{a.dist} km {a.ok ? "✓" : ""}</span>
                </div>
              ))}
            </div>
          )} */}
        </div>

        {/* ── Mobile Toggle Bar ── */}
        {isMobile && (
          <button className="mobile-toggle" onClick={() => setPanelOpen(o => !o)}>
            {panelOpen ? "▲ Hide Panel" : "▼ Show Panel"}
          </button>
        )}

        {/* ── Elevation Toggle for Mobile (outside panel, always visible) ── */}
        {isMobile && route && (
          <button
            onClick={() => elevationData && elevationData.length > 1 && setShowElevationChart(v => !v)}
            disabled={!elevationData || elevationData.length < 2}
            className="mobile-toggle"
            style={{
              background: showElevationChart ? "#22ff8818" : "#161b22",
              color: showElevationChart ? "#22ff88" : (!elevationData || elevationData.length < 2 ? "#30363d" : "#8b949e"),
              borderTop: "1px solid #22ff8840",
              fontFamily: "inherit", fontSize: 11, whiteSpace: "normal",
            }}
          >
            📈 Elevation {showElevationChart ? "▼" : "▲"} &nbsp;
            <span style={{ color: elevationData && elevationData.length > 1 ? "#e6edf3" : "#30363d" }}>
              {elevationData && elevationData.length > 1
                ? `${Math.round(elevationData[0].ele)}–${Math.round(elevationData[elevationData.length - 1].ele)} m · ▲${Math.round(Math.max(...elevationData.map(p => p.ele)) - Math.min(...elevationData.map(p => p.ele)))} m gain`
                : "No elevation data"}
            </span>
          </button>
        )}

        {/* ── Map ── */}
        <div className="app-map" style={{ flex: 1, position: "relative", background: "#0d1117" }}>
          {!leafletLoaded && (
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "#30363d", fontSize: 14 }}>
              Loading map...
            </div>
          )}
          {leafletLoaded && !route && !startCoord && (
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center", color: "#30363d", pointerEvents: "none" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🏃</div>
              <div style={{ fontSize: 13, letterSpacing: 2 }}>SEARCH MAP & SET POINTS</div>
            </div>
          )}
          {leafletLoaded && (
            <MapView
              routeGeoJson={route}
              startCoord={startCoord}
              endCoord={endCoord}
              waypoints={waypoints}
              onWaypointDrag={handleWaypointDrag}
              onWaypointDelete={handleWaypointDelete}
              onRouteClick={handleRouteClick}
              isRerouting={isRerouting}
              clickMode={clickMode}
              onMapClick={handleMapClick}
              flyTarget={flyTarget}
              showArrows={showArrows}
              onToggleArrows={() => setShowArrows(a => !a)}
              elevationData={elevationData}
              showElevationChart={showElevationChart}
              onToggleElevationChart={() => setShowElevationChart(v => !v)}
              isMobile={isMobile}
            />
          )}
        </div>
      </div>
    </>
  );
}
