import React, { useRef, useEffect, useState } from "react";

// ─── Elevation Chart Overlay ─────────────────────────────────────────────────

export default function ElevationChart({
  elevationData,
  routeGeoJson,
  hoverChartIdx,
  setHoverChartIdx,
  onToggleElevationChart,
  showElevationChart,
}) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [chartW, setChartW] = useState(null);

  // Measure container width whenever chart visibility changes
  useEffect(() => {
    if (!showElevationChart) return;
    const el = containerRef.current;
    if (!el) return;
    // Measure synchronously after layout
    requestAnimationFrame(() => {
      if (containerRef.current) {
        setChartW(Math.max(400, containerRef.current.clientWidth));
      }
    });
  }, [showElevationChart]);

  // Also track resize while visible
  useEffect(() => {
    if (!showElevationChart || !containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(([entry]) => {
      setChartW(Math.max(400, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showElevationChart]);

  if (!showElevationChart || !elevationData || elevationData.length < 2 || !routeGeoJson) return null;
  if (!chartW) return <div ref={containerRef} style={{ width: "100%", height: 160 }} />;

  const data = elevationData;
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

  const cursorX = hoverChartIdx != null && data[hoverChartIdx]
    ? padL + (data[hoverChartIdx].distKm / totalDist) * plotW
    : null;

  return (
    <div ref={containerRef} style={{
      position: "absolute", bottom: 0, left: 0, right: 0,
      background: "#161b22ee", border: "none", borderTop: "1px solid #22ff8860",
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
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
        onMouseMove={handleChartMove} onMouseLeave={handleChartLeave}
        style={{ display: "block", borderRadius: 6 }}>
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
        {cursorX != null && hoverChartIdx != null && data[hoverChartIdx] && (
          <>
            <line x1={cursorX} y1={padT} x2={cursorX} y2={padT + plotH} stroke="#ff4444" strokeWidth="2" strokeDasharray="4 2" />
            <circle cx={cursorX} cy={padT + plotH - ((data[hoverChartIdx].ele - minEle) / range) * plotH} r="5" fill="#ff4444" stroke="#0d1117" strokeWidth="2" />
            <rect x={cursorX > padL + plotW / 2 ? cursorX - 70 : cursorX + 10} y={padT} width="64" height="40" rx="4" fill="#0d1117ee" stroke="#ff444460" />
            <text x={cursorX > padL + plotW / 2 ? cursorX - 38 : cursorX + 38} y={padT + 16} textAnchor="middle" fill="#ff4444" fontSize="16" fontFamily="monospace">{data[hoverChartIdx].distKm.toFixed(1)} km</text>
            <text x={cursorX > padL + plotW / 2 ? cursorX - 38 : cursorX + 38} y={padT + 33} textAnchor="middle" fill="#e6edf3" fontSize="16" fontFamily="monospace">{Math.round(data[hoverChartIdx].ele)} m</text>
          </>
        )}
      </svg>
    </div>
  );
}
