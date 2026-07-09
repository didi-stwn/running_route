# Running Route Planner

A React-based web application for planning running routes with precise distance targets. Uses **OSRM** (Open Source Routing Machine) for road-following routes and **OpenTopoData** for elevation profiles.

## Preview

<p align="center">
  <a href="https://didi-stwn.github.io/running_route/" target="_blank" rel="noopener noreferrer">
    <img src="public/running_route.png" alt="Running Route Planner Preview" width="100%" />
  </a>
</p>

<p align="center">
  <a href="https://didi-stwn.github.io/running_route/" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/🚀_Live_Demo-Click_Here-4FC08D?style=for-the-badge" alt="Live Demo" />
  </a>
</p>

## Features

### Route Planning
- **Set Start & End Points** — Search by address or click directly on the map
- **Target Distance** — Enter a desired distance (km) with optional margin
- **Automatic Detour Algorithm** — Finds road-following routes that match your target distance by offsetting waypoints to the left/right of the direct road
- **Multiple Alternatives** — Cycles through alternative routes within target range
- **Loop Routes** — When start≈end, generates outward-looping route proposals

### Interactive Map
- **Click to Add Waypoints** — Click anywhere on the route to insert a waypoint
- **Drag to Reshape** — White dot handles let you drag waypoints to reshape the route (auto-reroutes on drag)
- **Double-click to Delete** — Remove unwanted waypoints
- **Route Arrow Indicators** — Toggle directional arrows along the route

### Elevation Profile
- **Elevation Chart** — Toggle a profile chart showing elevation vs. distance
- **Hover to Locate** — Hover over the chart to see the corresponding point on the map
- **Auto-fetched** — Elevation data retrieved from OpenTopoData API via custom proxy

### GPX Import/Export
- **Export as GPX** — Download your planned route as a GPX file
- **Import GPX** — Load a GPX file to visualize and modify existing routes

### Mobile Support
- Responsive layout adapts to mobile screens
- Touch-friendly waypoint handles

## How the Detour Algorithm Works

1. **Direct Route** — OSRM calculates the shortest road route between start and end
2. **Side Offset Waypoints** — The algorithm creates waypoints offset perpendicular to the road direction (both left and right sides)
3. **Route Through Waypoints** — OSRM routes through these offset waypoints, creating a longer route
4. **Interpolation** — Results are interpolated between the best above-target and below-target offsets to find the "sweet spot"
5. **Ranking** — All alternatives are sorted by closeness to the target distance

For loop routes (start ≈ end), the algorithm generates waypoints radiating outward in an arc, creating loop-shaped routes that return to the start.

## Tech Stack

- **React 19** with hooks (`useState`, `useEffect`, `useCallback`, `useRef`, `useMemo`)
- **Leaflet.js** for map rendering (loaded via CDN)
- **OSRM** — `https://router.project-osrm.org` for road routing
- **OpenTopoData** — `https://api.opentopodata.org/v1/aster30m` for elevation data
- **Custom Proxy** — Vercel serverless function for CORS-free API access

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.\
The page will reload when you make changes.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

### `npm test`

Launches the test runner in interactive watch mode.

## Deployment

The app can be deployed to GitHub Pages or any static hosting. The custom proxy (`/custom-proxy`) can be deployed to Vercel to handle CORS for the OpenTopoData API.

### GitHub Pages
1. Update `"homepage"` in `package.json` to your GitHub Pages URL
2. Run `npm run build`
3. Deploy the `build` folder to GitHub Pages

### Vercel Proxy (for elevation API)
The `custom-proxy/` directory contains a Vercel serverless function that proxies requests to OpenTopoData, avoiding CORS issues in production.
