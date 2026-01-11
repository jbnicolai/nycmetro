# NYC Real-Time Transit Map 🚇 + 🚲

A high-performance, real-time visualization of New York City's transit pulse. This application combines the massive scale of the MTA subway system with the granularity of Citibike, offering a "Simulation Anchored to Reality" driven by live signal data.

![Project Screenshot](assets/app-screenshot.png)

## ✨ Features

*   **Hybrid Real-Time Engine**: Visualizes trains moving along accurate track geometries. Positions are interpolated from the static schedule but "snapped" to reality using live GTFS-RT signal data.
*   **Live Citibike Docks**: Toggleable layer showing real-time bike & dock availability from the GBFS feed.
*   **Parallel Line Rendering**: Routes are rendered with offset geometries to handle the complexity of NYC's interlining (e.g., A/C/E lines sharing tracks).
*   **Performance First**: 
    *   **Zero-Dependency Backend**: Pure Python standard library `http.server`.
    *   **Vector-Based**: Uses Leaflet.js & Turf.js for smooth client-side animation.
    *   **Smart Loading**: Initial map loads instantly; schedule data streams in asynchronously.

---

## 🚀 Quick Start

### 1. Prerequisites
*   Python 3.9+

### 2. Run Locally
We provide a helper script to set up the environment and install dependencies (`protobuf`, `requests`).

```bash
./run_dev.sh
```
Open [http://localhost:8001](http://localhost:8001).

---

## 🧠 Methodology: Verified Simulation

Unlike consumer maps (Google/Apple) that use Machine Learning to *predict* arrivals based on history, this engine visualizes the **Signal Truth**.

| Layer | Source | Precision | Description |
| :--- | :--- | :--- | :--- |
| **Foundation** | **GTFS Schedule** | 📅 Planned | The official "ideal" timetable. |
| **Reality** | **GTFS-Realtime** | 📡 Actual | Live telemetry from track signals. |
| **User View** | **Hybrid Sim** | 🟢 Live | We run a physics simulation of the schedule, continuously time-shifting trains to match their reported live position. |

*   **The "Ghost" Technique**: Every scheduled train is instantiated as a simulation object.
*   **The "Anchor"**: We poll the [MTA API](https://api.mta.info) every 30 seconds. If a train is reported delayed (e.g., **5 minutes late**), its entire trajectory is shifted, preserving the physics of travel (speed, dwell times) while respecting the live arrival time.

---

## 🛠️ Architecture for Developers

The project uses a "Thick Client, Thin Server" architecture to maximize scalability and reduce hosting costs (runs on $5/mo instances).

### Backend (`server.py`)
*   **Role**: Static file server + API Gateway.
*   **Tech**: Pure Python.
*   **Key Dependencies**:
    *   `gtfs-realtime-bindings`: To parse MTA Protobuf feeds.
    *   `requests`: To fetch data from MTA.
*   **Data Pipeline** (`scripts/update_data.py`): An ETL script that downloads the 50MB+ GTFS zip, strips unused fields (ShapeDescriptions, etc.), and generates optimized JSONs (`subway_config.json`, `subway_schedule.json`) for the client.

### Frontend (`src/`)
*   **Tech**: Vanilla ES Modules (No Webpack/React overhead).
*   **Core Components**:
    *   `animation.js`: The heart of the app. Handles the simulation loop, time interpolation, and Turf.js track snapping.
    *   `realtime.js`: The collection agent. Polls the backend buffer and computes "Delay Deltas" for the animator.
    *   `map.js`: Leaflet controller for layer management (GeoJSON rendering).

### Folder Structure
```
├── data/               # Processed JSONs (Gitignored)
├── src/                # Frontend Source
├── scripts/            # ETL & Maintenance Scripts
├── server.py           # Application Server
└── run_dev.sh          # Native Runner
```

---

## 🚢 Deployment

The application is containerized and ready for PaaS deployment (Railway, Render, Heroku).

1.  **Docker**: The included `Dockerfile` builds a lightweight alpine image.
2.  **Environment**: 
    *   `PORT`: Defaults to 8000.
    *   `ENV`: Set to `production` to silence debug logs.

---

## 🔮 Roadmap & Backlog

### ✅ Completed
*   [x] **Real-Time GTFS Integration**: Integrated live Protobuf feeds from MTA.
*   [x] **Smooth Zoom Animation**: Improved "Locate Me" transitions.
*   [x] **Loading States**: Added granular loading indicators for heavy schedule data.

### 🚧 Up Next
*   [ ] **Visual Line De-interlacing**: In high-density corridors (e.g., Manhattan Trunk Lines), lines currently overlap. We need a geometry offset algorithm to render them side-by-side.
*   [ ] **Search & Wayfinding**: detailed station search and highlight functionality.
*   [ ] **Service Alerts**: Display "Rerouted" or "Suspended" banners based on GTFS Alert feeds.