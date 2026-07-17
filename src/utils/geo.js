// ─── Geographic Helpers ──────────────────────────────────────────────────────

export function toRad(d) { return d * Math.PI / 180; }

export function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing([lon1, lat1], [lon2, lat2]) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function movePoint([lon, lat], brng, dist) {
  const R = 6371000, d = dist / R, b = toRad(brng);
  const lat1 = toRad(lat), lon1 = toRad(lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

// ─── Geocoding ───────────────────────────────────────────────────────────────

export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  if (!data.length) throw new Error(`Location "${query}" not found`);
  return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
}

export async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  return data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
