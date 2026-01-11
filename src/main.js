import './logger.js';
import { initMap, renderSubwayLines, toggleRouteLayer, toggleRouteLayerBatch, layers, visibilityFilter } from './map.js';
import { fetchConfig } from './api.js';
import { renderStations } from './stations.js';
import { createLegend, updateLegendLines } from './legend.js';
import { startTrainAnimation } from './animation.js';
import { fetchCitibikeStations, filterCitibikeStations } from './citibike.js';
import { initRealtime } from './realtime.js';
import { StatusPanel } from './status-panel.js';
import { initAlerts } from './alerts.js';

// Add Citibike Layer to State
layers.citibike = L.layerGroup();

async function runApp() {
    console.log("Initializing App (Modular)...");

    const map = initMap();
    layers.citibike.addTo(map);

    // [MOD] triggerLocate moved later in runApp to avoid jank during initial render


    createLegend(map, layers, async (color, checked) => {
        if (!checked) {
            layers.citibike.eachLayer(layer => {
                if (layer.options.citibikeType === color) {
                    layers.citibike.removeLayer(layer);
                }
            });
            return;
        }

        const stations = await fetchCitibikeStations();

        // Calculate Stats
        const total = stations.length;
        const empty = stations.filter(s => s.num_bikes_available === 0).length;
        const withEbikes = stations.filter(s => s.num_ebikes_available > 0).length;

        // "Normal Bikes Only": Stations with bikes but NO e-bikes
        const normalOnlyStations = stations.filter(s => {
            const hasBikes = s.num_bikes_available > 0;
            const hasEbikes = s.num_ebikes_available > 0;
            return hasBikes && !hasEbikes;
        }).length;

        // GBFS Spec: num_bikes_available includes e-bikes
        const totalBikes = stations.reduce((acc, s) => acc + s.num_bikes_available, 0);

        // Update Panel
        StatusPanel.update("citibike-total", `${total} Loaded`);
        StatusPanel.update("citi-empty", empty);
        StatusPanel.update("citi-normal-only", normalOnlyStations);
        StatusPanel.update("citi-ebike", withEbikes);
        StatusPanel.update("citi-bikes", totalBikes);

        const details = document.getElementById('citibike-details');
        if (details) details.style.display = 'block';

        StatusPanel.log(`Fetched ${total} stations. ${totalBikes} bikes avail.`);

        const filtered = filterCitibikeStations(stations, color);

        filtered.forEach(s => {
            const marker = L.circleMarker([s.lat, s.lon], {
                radius: 4,
                fillColor: color === 'green' ? '#22c55e' : (color === 'yellow' ? '#fbbf24' : '#ef4444'),
                color: '#fff',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8,
                citibikeType: color // Tag for removal
            });

            marker.bindPopup(`
                <b>${s.name}</b><br>
                🚲 Bikes: ${s.num_bikes_available}<br>
                ⚡ E-Bikes: ${s.num_ebikes_available}<br>
                🅿️ Docks: ${s.num_docks_available}
             `);

            marker.addTo(layers.citibike);
        });
    });



    try {
        // 1. Critical Fetch: Core Map Data (Parallel)
        console.time("CoreFetch");
        const [config, stationsRes, neighborhoodsRes] = await Promise.all([
            fetchConfig().catch(e => { throw new Error("Config Fetch Failed: " + e) }),
            fetch('./data/subway-stations.geojson').then(r => r.json()).catch(e => { throw new Error("Stations Fetch Failed: " + e) }),
            fetch('./data/nyc-neighborhoods.geojson').then(r => r.json()).catch(e => { throw new Error("Neighborhoods Fetch Failed: " + e) }),
        ]);
        console.timeEnd("CoreFetch");

        const trainLoader = document.getElementById('train-loading');
        let renderedShapes = config.shapes; // Fallback

        // Create a promise that resolves when the map stops moving or after a timeout
        const mapReady = new Promise(resolve => {
            let fired = false;
            const done = () => { if (!fired) { fired = true; resolve(); } };
            map.once('moveend', done);
            setTimeout(done, 4000); // Guard timeout
        });

        // 2. Trigger Auto-Locate IMMEDIATELY (Only if approved, else it stays default)
        if (window.triggerLocate) {
            window.triggerLocate();
        }

        // Wait for map to settle before slamming the CPU with rendering
        await mapReady;

        StatusPanel.init();
        StatusPanel.log("Location locked. Rendering system...");
        StatusPanel.update("routes", Object.keys(config.routes).length);

        // --- PHASE 2: Hide Overlay, Rendering Static Layers ---
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('fade-out');
            setTimeout(() => loadingOverlay.style.display = 'none', 500);
        }
        if (trainLoader) trainLoader.classList.remove('hidden');

        // Neighborhoods
        L.geoJSON(neighborhoodsRes, {
            style: { color: '#38bdf8', weight: 1, opacity: 0.3, fillColor: '#0f172a', fillOpacity: 0.1 }
        }).addTo(layers.neighborhoods);

        // Subway Lines
        console.log("Rendering Subway Lines...");
        const lineResult = await renderSubwayLines(map, config.shapes, config.routes);
        if (lineResult) renderedShapes = lineResult;

        // Update Legend
        updateLegendLines(config.routes, toggleRouteLayerBatch);

        // Init Alerts
        const legendControl = document.querySelector('.legend-control');
        initAlerts(legendControl);

        // Initial Station Render
        renderStations(stationsRes, layers.stations, null, config.routes);
        StatusPanel.update("stations", stationsRes.features ? stationsRes.features.length : 0);


        // 5. Synchronized Data Loading: Schedule + Real-time
        StatusPanel.log("Loading Schedule & Real-time data...");
        console.time("HeavyLoading");

        try {
            const [scheduleRes] = await Promise.all([
                fetch('/api/schedule').then(r => r.json()),
                initRealtime() // Also fetches first RT payload
            ]);
            console.timeEnd("HeavyLoading");
            StatusPanel.log("Data synchronized. Starting engines...");

            // Re-render stations with schedule data to enable popups matches
            layers.stations.clearLayers();
            renderStations(stationsRes, layers.stations, scheduleRes, config.routes);

            // Start Animation
            console.log("Starting animation with filter:", visibilityFilter);
            startTrainAnimation(renderedShapes, config.routes, scheduleRes, visibilityFilter);

            // --- PHASE 3 COMPLETE: Hide Train Loader ---
            if (trainLoader) {
                trainLoader.classList.add('hidden');
            }

        } catch (e) {
            console.warn("Synchronized Loading Failed", e);
            StatusPanel.log("Data synchronization failed.");
            if (trainLoader) {
                trainLoader.innerHTML = "<span>Sync Error</span>";
                setTimeout(() => trainLoader.classList.add('hidden'), 3000);
            }
        }

    } catch (err) {
        // If critical fetch fails (Map Config/Stations)
        console.error("CRITICAL BOOT ERROR:", err);
        alert(`CRITICAL ERROR:\n${err.message}`);
    }
}

document.addEventListener('DOMContentLoaded', runApp);
