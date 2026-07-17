// ─── GPX Import / Export ──────────────────────────────────────────────────────

import { haversine } from "./geo";

export function exportGPX(routeGeoJson, distanceKm) {
  const coords = routeGeoJson.features[0].geometry.coordinates;
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

export function parseGPX(xmlText) {
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
