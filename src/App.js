import React, { useState, useEffect, useRef, useCallback } from "react";
import { S } from "./styles/theme";
import { MapView } from "./components/MapView";
import Sidebar from "./components/Sidebar";
import { geocode, reverseGeocode, haversine } from "./utils/geo";
import { getRoute, enrichElevation, routeDistanceKm, extractElevationProfile, sampleIntermediateWaypoints } from "./utils/api";
import { buildOneWayDetour, buildLoopDetour } from "./utils/route";
import { parseGPX } from "./utils/gpx";

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
  const [altRoutes, setAltRoutes] = useState([]);
  const [altIdx, setAltIdx] = useState(0);
  const [clickMode, setClickMode] = useState(null);
  const [flyTarget, setFlyTarget] = useState(null);
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
    e.target.value = "";

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

      try {
        const sl = await reverseGeocode(result.startCoord[1], result.startCoord[0]);
        setStartLabel(sl);
      } catch { setStartLabel(`${result.startCoord[1].toFixed(4)}, ${result.startCoord[0].toFixed(4)}`); }
      try {
        const el = await reverseGeocode(result.endCoord[1], result.endCoord[0]);
        setEndLabel(el);
      } catch { setEndLabel(`${result.endCoord[1].toFixed(4)}, ${result.endCoord[0].toFixed(4)}`); }

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
    const mode = clickModeRef.current;
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
  }, []);

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
      const enrichedGeo = await enrichElevation(geojson);
      setRoute(enrichedGeo);
      const elev = extractElevationProfile(enrichedGeo);
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
      return [...prev.slice(0, bestIdx), coord, ...prev.slice(bestIdx)];
    });
  }, []);

  // Initial route search
  const findRoute = useCallback(async () => {
    const { distance, margin } = form;
    if (!distance || !startCoord || !endCoord) {
      setStatus({ type: "error", msg: "Set start & end points on the map and enter distance!" }); return;
    }
    const targetM = parseFloat(distance) * 1000;
    const marginM = parseFloat(margin || 0) * 1000;
    const minM = targetM - marginM, maxM = targetM + marginM;

    setStatus({ type: "loading", msg: "Getting direct road route..." });
    setRoute(null); setWaypoints([]); setAltRoutes([]); setAltIdx(0); setElevationData(null); setShowElevationChart(false);

    const prevStart = startCoord, prevEnd = endCoord;

    try {
      setStatus({ type: "loading", msg: "Requesting direct route from OSRM..." });
      const directGeoJson = await getRoute([prevStart, prevEnd], profile);
      let directCoords = directGeoJson.features[0].geometry.coordinates;
      const directDist = directGeoJson.features[0].properties.summary.distance;

      const isCloseLoop = directDist < 100 || directCoords.length < 8;

      const log = [];
      log.push({ attempt: 0, dist: (directDist / 1000).toFixed(2), ok: directDist >= minM && directDist <= maxM });

      const allAlts = [];
      allAlts.push({
        geojson: directGeoJson, distKm: (directDist / 1000).toFixed(2),
        distM: directDist, offsetM: 0,
        ok: directDist >= minM && directDist <= maxM,
      });

      const needLonger = directDist < minM;

      const sideSets = [1, -1];
      const baseOffsets = needLonger
        ? [50, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500, 1800, 2200, 2600, 3000]
        : [50, 100, 150, 200, 300, 400, 500, 600, 800];

      const MAX_ATTEMPTS = 10;
      const tried = new Set();
      let attemptsLeft = MAX_ATTEMPTS;
      for (const side of sideSets) {
        for (const off of baseOffsets) {
          if (attemptsLeft <= 0) break;
          const key = `${side}:${off}`;
          if (tried.has(key)) continue;
          tried.add(key);
          attemptsLeft--;
          const attemptNum = log.length;
          const sideLabel = side === 1 ? "right" : "left";
          setStatus({ type: "loading", msg: `Trying ${sideLabel} detour ${off}m... attempt ${attemptNum}` });
          try {
            let wps;
            if (isCloseLoop) {
              const loopWps = buildLoopDetour(prevStart, off, 3, side);
              wps = [prevStart, ...loopWps, prevEnd];
            } else {
              wps = buildOneWayDetour(directCoords, off, 3, side);
            }
            const geojson = await getRoute(wps, profile);
            const dist = geojson.features[0].properties.summary.distance;
            const diff = Math.abs(dist - targetM);
            const ok = dist >= minM && dist <= maxM;
            const pctOff = diff / targetM;
            log.push({ attempt: attemptNum, dist: (dist / 1000).toFixed(2), ok });
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
        if (attemptsLeft <= 0) break;
      }

      // Interpolation
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
                let wps;
                if (isCloseLoop) {
                  const loopWps = buildLoopDetour(prevStart, absInterp, 3, interpSide);
                  wps = [prevStart, ...loopWps, prevEnd];
                } else {
                  wps = buildOneWayDetour(directCoords, absInterp, 3, interpSide);
                }
                const geojson = await getRoute(wps, profile);
                const dist = geojson.features[0].properties.summary.distance;
                const ok = dist >= minM && dist <= maxM;
                log.push({ attempt: log.length, dist: (dist / 1000).toFixed(2), ok });
                const pctOff = Math.abs(dist - targetM) / targetM;
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

      const sortable = isCloseLoop
        ? allAlts.filter(a => a.offsetM !== 0)
        : allAlts;

      sortable.sort((a, b) => {
        const diffA = Math.abs(a.distM - targetM);
        const diffB = Math.abs(b.distM - targetM);
        if (diffA !== diffB) return diffA - diffB;
        return Math.abs(a.offsetM) - Math.abs(b.offsetM);
      });

      setAltRoutes(allAlts);
      setAltIdx(0);

      const best = sortable[0] || allAlts[0];
      const enrichedBest = await enrichElevation(best.geojson);
      const intermedCoords = sampleIntermediateWaypoints(enrichedBest, 3);
      setWaypoints(intermedCoords);
      setRoute(enrichedBest);
      setElevationData(extractElevationProfile(enrichedBest));
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
  const nextAlternative = useCallback(async () => {
    if (altRoutes.length <= 1) return;
    const nextIdx = (altIdx + 1) % altRoutes.length;
    setAltIdx(nextIdx);
    const alt = altRoutes[nextIdx];
    const enrichedAlt = await enrichElevation(alt.geojson);
    setRoute(enrichedAlt);
    const elev = extractElevationProfile(enrichedAlt);
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
        {/* ── Sidebar Panel ── */}
        <div className={`app-panel${isMobile && !panelOpen ? " collapsed" : ""}`} style={S.panel}>
          <Sidebar
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            handleSearch={handleSearch}
            handleSearchKeyDown={handleSearchKeyDown}
            clickMode={clickMode}
            setClickMode={setClickMode}
            startCoord={startCoord}
            startLabel={startLabel}
            endCoord={endCoord}
            endLabel={endLabel}
            form={form}
            handleChange={handleChange}
            profile={profile}
            setProfile={setProfile}
            findRoute={findRoute}
            isLoading={isLoading}
            status={status}
            routeInfo={routeInfo}
            waypoints={waypoints}
            altRoutes={altRoutes}
            altIdx={altIdx}
            nextAlternative={nextAlternative}
            route={route}
            handleImportGPX={handleImportGPX}
            fileInputRef={fileInputRef}
          />
        </div>

        {/* ── Mobile Toggle Bar ── */}
        {isMobile && (
          <button className="mobile-toggle" onClick={() => setPanelOpen(o => !o)}>
            {panelOpen ? "▲ Hide Panel" : "▼ Show Panel"}
          </button>
        )}

        {/* ── Elevation Toggle for Mobile ── */}
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
