// ─── Theme / Style Constants ──────────────────────────────────────────────────

export const S = {
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
