// ─── Route Detour Builders ────────────────────────────────────────────────────

import { bearing, movePoint } from "./geo";

// Build a ONE-WAY detour route — all waypoints offset to one side of the direct
// road line, creating an arc that never doubles back on itself.
// side: 1 = right of road, -1 = left of road
export function buildOneWayDetour(roadCoords, offsetMeters, numWaypoints = 3, side = 1) {
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

// Build a loop route from a single start point (start≈end).
// Creates waypoints radiating outward from start in a wide arc,
// forcing OSRM to find a road loop. The waypoints are anchored
// at the real start coord on both ends.
// side: 1 = clockwise arc, -1 = counter-clockwise arc
export function buildLoopDetour(startCoord, arcOffsetMeters, numWaypoints = 3, side = 1) {
  const wps = [];
  const arcAngles = side === 1
    ? [30, 90, 150]   // clockwise: sweep right side
    : [330, 270, 210]; // counter-clockwise: sweep left side
  for (let i = 0; i < numWaypoints; i++) {
    const frac = (i + 1) / (numWaypoints + 1);
    const dist = arcOffsetMeters * (0.5 + frac * 0.5);
    wps.push(movePoint(startCoord, arcAngles[i] || (arcAngles[0] + side * i * 60), dist));
  }
  return wps;
}
