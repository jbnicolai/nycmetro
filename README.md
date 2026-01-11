# NYC Real-Time Transit Map
A real-time visualization of the New York City transit system, combining MTA subway data with Citi Bike availability. The application renders train movements based on a hybrid system of static schedules and live GTFS-Realtime signal data.

![NYC Real-Time Transit Map](assets/app-screenshot.png)

## data-sources
The application aggregates data from the following public APIs:
- **MTA GTFS-Static**: Provides the base schedule, route geometries (shapes.txt), and station locations.
- **MTA GTFS-Realtime**: Provides live updates via Protocol Buffers (Probobuf).
    - **Feed 1, 2, 11, 16, 21**: Numbered Lines, L, SIR.
    - **Feed 26**: A/C/E Lines.
    - **Feed 16**: N/Q/R/W Lines.
    - **Feed 21**: B/D/F/M Lines.
- **Citi Bike GBFS (General Bikeshare Feed Specification)**: Provides real-time station status (bikes available, e-bikes available, docks available).

## Architecture

The project employs a client-heavy architecture to minimize server load and latency.

### Backend (`server.py`)
- **Runtime**: Python 3.9+.
- **Framework**: Standard Library `http.server`.
- **Responsibilities**:
    - Serves static assets (HTML/JS/CSS).
    - Acts as an API proxy for MTA Realtime Feeds to handle CORS.
    - Parses GTFS Protobuf data using `google.transit.gtfs_realtime_pb2` and converts it to JSON for the client.
    - Implements in-memory caching for Realtime feeds (30s TTL) and Alerts (60s TTL).

### Frontend
- **Framework**: Vanilla JavaScript (ES6 Modules).
- **Rendering Engine**: Leaflet.js.
- **Geospatial Processing**: Turf.js (used for line slicing, train positioning, and geometry snapping).
- **State Management**:
    - `animation.js`: Manages the requestAnimationFrame loop. It interpolates train positions along the SVG path based on the current time and live schedule deviations.
    - `realtime.js`: Polls the backend for trip updates and maintains a synchronization map (`tripId` -> `deviation`).
    - `alerts.js`: Polls for service alerts and updates the UI accordingly.

## Installation & Running Locally

### Prerequisites
- Python 3.9 or higher.
- `pip` (Python Package Manager).

### Setup
1.  **Clone the repository**.
2.  **Initialize the Environment**:
    The included script sets up a virtual environment and installs the required `requests` and `protobuf` libraries.
    ```bash
    ./run_dev.sh
    ```
3.  **Access the Application**:
    Navigate to `http://localhost:8001`.

### Data Updates
The static schedule data (`data/subway_schedule.json`) is generated from the raw MTA GTFS dump. To update the base topology or schedule:
1.  Download the latest NYC Subway GTFS.
2.  Run the ETL script:
    ```bash
    python3 scripts/update_data.py
    ```

## Development Reference

### Project Structure
```
.
├── server.py              # Main backend server (API & Static File serving)
├── index.html             # Application entry point
├── run_dev.sh             # Dev startup script
├── scripts/
│   ├── update_data.py     # ETL script to download/process GTFS data
│   └── optimize_geojson.py# Utility to minify shape data
├── src/                   # Frontend Source Code
│   ├── main.js            # App initialization & core logic
│   ├── map.js             # Leaflet map configuration & rendering
│   ├── animation.js       # Train animation loop & path interpolation
│   ├── realtime.js        # GTFS-Realtime processing
│   ├── stations.js        # Station rendering & schedule logic
│   ├── citibike.js        # Citi Bike data integration
│   ├── alerts.js          # Service alerts state
│   └── logger.js          # Remote logging utility
└── data/                  # Generated data artifacts (gitignored except examples)
```

### Debugging
- **Logs**: The frontend pipes `console.log` to the backend when `?debug=true` is in the URL. Check `frontend_debug.log`.
- **Backend**: `server.py` output is printed to stdout/stderr.
- **Visuals**: Use `isDebugSegment` in `animation.js` to inspect path finding logic for specific trains.

## Roadmap

### Visuals & UX
- [ ] **Realistic Train Sizing**: Optionally show trains in a more realistic size (real length based on number of wagons, either real or estimated).
- [ ] **Mobile Zoom**: Fix map zooming to avoid scaling the UI.
- [ ] **Citi Bike Timelapse**: Create a 24h/7d timelapse visualization of station availability.
- [ ] **Browser History**: Implement back/undo navigation for station and train selections.
- [ ] **Deep Linking**: Support deep linking to trains/stations via URL hash.

### Compliance & Architecture
- [ ] **MTA API Compliance**: Download API feeds server-side and serve to clients via a proxy. Implement an on-demand mechanism with cross-user caching to minimize server costs and MTA load.
- [ ] **Smart Filtering**: Cache Citi Bike data (~30s TTL) to avoid reloading on filter changes.
- [ ] **Smart Matching**: Improve ID matching algorithm (fuzzy route/direction matching) to link more live trains to the schedule.
- [ ] **Data Optimization**: Evaluate migrating JSON schedule data to a binary format (e.g., FlatBuffers) for faster parsing.
- [ ] **Modularization**: Continue breaking down `stations.js` and `animation.js` into smaller, domain-specific modules.

## Known Issues
- **Ghost Trains**: Some real-time trips may not match perfectly to the static schedule, resulting in "Unknown" destinations or missing stops.
- **Incorrect Train Instance Selection**: Station links for upcoming trains do not always center on the correct train instance (e.g., selecting a train further along the route instead of the one about to arrive).
- **Realtime Reload Jitter**: Every time realtime data is reloaded, all trains 'jump' to a new position as their delay values are updated abruptly.

## Development Workflow
> [!IMPORTANT]
> **Verify before Commit**: Do not commit changes to the main branch before explicitly confirming with the user that the functionality works as expected.
> **DO NOT PUSH**: Do not push changes to the remote repository without explicit user permission.

## Agent Learnings
1. **Centralized Logic**: Moving shared logic (like `getMatchingTrip` in `realtime.js`) early prevents "Ghost Train" bugs where different parts of the app behave inconsistently.
2. **Robust UI Config**: When adding dynamic text (like "Approaching"), always check for text wrapping and adjust container widths/flex properties immediately.