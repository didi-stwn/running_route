import React, { useState, useRef, useEffect } from "react";
import ElevationChart from "./ElevationChart";
import { haversine, bearing } from "../utils/geo";

// ─── Map View ────────────────────────────────────────────────────────────────

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
        let arrowSpacingM = 100;
        if (zoom <= 9) arrowSpacingM = 1000;
        else if (zoom <= 10) arrowSpacingM = 800;
        else if (zoom <= 11) arrowSpacingM = 500;
        else if (zoom <= 12) arrowSpacingM = 300;
        else if (zoom <= 13) arrowSpacingM = 200;
        else if (zoom <= 14) arrowSpacingM = 150;
        let accumulated = 0;
        let lastPlacedIdx = 0;
        let totalDist = 0;
        for (let i = 1; i < coords.length; i++) {
          const segDist = haversine(coords[i - 1], coords[i]);
          totalDist += segDist;
          accumulated += segDist;

          if (accumulated >= arrowSpacingM && i > lastPlacedIdx) {
            const overshoot = accumulated - arrowSpacingM;
            const t = 1 - overshoot / segDist;
            const [lon1, lat1] = coords[i - 1];
            const [lon2, lat2] = coords[i];
            const lon = lon1 + (lon2 - lon1) * t;
            const lat = lat1 + (lat2 - lat1) * t;
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
      html: `<div style="width:75px;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 6px #000c)">
        <div style="background:${color};color:#0d1117;font-weight:800;font-family:monospace;padding:4px 10px;border-radius:6px;font-size:11px;white-space:nowrap">${label}</div>
        <div style="width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:10px solid ${color};margin-top:-1px;filter:drop-shadow(0 2px 2px #0004)"></div>
      </div>`,
      iconAnchor: [40, 44],
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

  // Draw draggable waypoint handles
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
      <div ref={mapRef} style={{ width: "100%", height: "100%", cursor: clickMode ? "pointer" : "" }} />
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
      {!isRerouting && routeGeoJson && !isMobile && (
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
            zIndex: 1000,
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
      <ElevationChart
        elevationData={elevationData}
        routeGeoJson={routeGeoJson}
        hoverChartIdx={hoverChartIdx}
        setHoverChartIdx={setHoverChartIdx}
        onToggleElevationChart={onToggleElevationChart}
        showElevationChart={showElevationChart}
      />
    </div>
  );
};

export const MapView = React.memo(MapViewInner, (prev, next) => {
  // Only re-render if these specific props actually changed values
  const keys = ["routeGeoJson", "startCoord", "endCoord", "waypoints", "isRerouting", "clickMode", "flyTarget", "showArrows", "elevationData", "showElevationChart", "isMobile"];
  const changed = keys.filter(k => prev[k] !== next[k]);
  if (changed.length > 0) {
    return false; // props changed, re-render
  }
  return true; // skip re-render
});
