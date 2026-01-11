# NYC Real-Time Transit Map

> [!IMPORTANT]
> **Agent Instructions / Development Rules**:
> 1. **DO NOT PUSH** changes to the remote repository without explicit user permission.
> 2. Always verify code changes locally before asking to commit.

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

### Information Hierarchy
- [x] **Service Alerts**: Display active disruptions and reroutes in the map legend and station popups.
- [x] **Live Train Counters**: Status panel shows the total number of scheduled vs. tracking trains.

### Visualization
- [x] **Line De-Interlacing**: Route lines are programmatically offset to prevent overlapping in high-density corridors like 8th Ave (A/C/E) and Broadway (N/Q/R/W).
- [x] **Train Animation**: Smooth interpolation of train markers along track geometry.

### Performance
- [x] **Payload Optimization**: Schedule data is lazily loaded and compressed.
- [ ] **Binary Format**: Evaluation of migrating JSON schedule data to a binary format (e.g., FlatBuffers) for faster parsing on mobile devices.
- [ ] **Interaction**: Double-click on a line to enter "Focus Mode" (hide all other lines).
- [ ] **Mobile Zoom**: Fix map zooming to avoid scaling the UI (mobile bug).
- [ ] **Citi Bike Timelapse**: Create a 24h/7d timelapse visualization of station availability to show traffic patterns.
- [ ] **Legend Improvements**: Controls to enable/disable all stations or select specific ones easily.
- [ ] **Smart Filtering**: Cache Citi Bike data to avoid reloading on filter changes (~30s TTL).
- [ ] **Load Optimization**: Further improve initial load metrics and loading UI.
- [ ] **Browser History**: Implement back/undo navigation for station and train selections.
- [ ] **Deep Linking**: Support deep linking to trains and stations via URL hash/query parameters.
- [ ] **Render Extra Trains**: Visualize unscheduled "ghost" trains from the real-time feed.
- [ ] **Smart Matching**: Improve ID matching algorithm (fuzzy route/direction matching) to link more live trains to the schedule.

## Known Issues
- **Delay Information on Stations**: Delay information is currently not showing up on station popups; only the time is displayed.

## Future Improvements (Todo)
- [ ] **Refactor**: Break down large files like `stations.js` and `animation.js` into smaller, more manageable modules.

## Agent Learnings
1. **Centralized Logic**: Moving shared logic (like `getMatchingTrip` in `realtime.js`) early prevents "Ghost Train" bugs where different parts of the app behave inconsistently.
2. **Robust UI Config**: When adding dynamic text (like "Approaching"), always check for text wrapping and adjust container widths/flex properties immediately.