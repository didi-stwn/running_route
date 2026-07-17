import React from "react";
import { S } from "../styles/theme";
import { exportGPX } from "../utils/gpx";

// ─── Sidebar Panel ───────────────────────────────────────────────────────────

export default function Sidebar({
  // Search
  searchQuery, setSearchQuery, handleSearch, handleSearchKeyDown,
  // Click mode for start/end
  clickMode, setClickMode,
  // Start / End coords & labels
  startCoord, startLabel, endCoord, endLabel,
  // Distance & margin & profile
  form, handleChange, profile, setProfile,
  // Routing
  findRoute, isLoading, status,
  routeInfo, waypoints,
  // Alternative routes
  altRoutes, altIdx, nextAlternative,
  // Export / Import
  route, handleImportGPX, fileInputRef,
}) {
  return (
    <div>
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
        {startCoord ? `✓ ${startLabel || `${startCoord[1].toFixed(5)}, ${startCoord[0].toFixed(5)}`}` : 'Click "Set Start" then click map'}
      </div>

      <label style={{ ...S.label, marginTop: 4 }}>2. Set Finish Point</label>
      <button
        style={S.btnOutline(clickMode === "end")}
        onClick={() => setClickMode(m => m === "end" ? null : "end")}
      >
        {clickMode === "end" ? "● Clicking map for FINISH..." : "⚑ Set Finish Point on Map"}
      </button>
      <div style={endCoord ? S.coordBadgeSet : S.coordBadge}>
        {endCoord ? `✓ ${endLabel || `${endCoord[1].toFixed(5)}, ${endCoord[0].toFixed(5)}`}` : 'Click "Set Finish" then click map'}
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
        style={{ ...S.input, cursor: "pointer", minHeight: 38 }}
      >
        <option value="driving-car">🚗 Driving (Car)</option>
        <option value="cycling-regular">🚴 Cycling</option>
        <option value="foot-walking">🚶 Walking / Running</option>
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
    </div>
  );
}
