import './logger.js';
import { initMap, renderSubwayLines, toggleRouteLayer, layers, visibilityFilter } from './map.js';
import { fetchConfig } from './api.js';
import { renderStations } from './stations.js';
import { createLegend, updateLegendLines } from './legend.js';
import { startTrainAnimation } from './animation.js';
import { fetchCitibikeStations, filterCitibikeStations } from './citibike.js';
import { StatusPanel } from './status-panel.js';

// Add Citibike Layer to State
layers.citibike = L.layerGroup();

async function runApp() {
    console.log("Initializing App (Modular)...");

    const map = initMap();
    layers.citibike.addTo(map);

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
        const [config, stationsRes, neighborhoodsRes, scheduleRes] = await Promise.all([
            fetchConfig().catch(e => { throw new Error("Config Fetch Failed: " + e) }),
            fetch('./data/subway-stations.geojson').then(r => r.json()).catch(e => { throw new Error("Stations Fetch Failed: " + e) }),
            fetch('./data/nyc-neighborhoods.geojson').then(r => r.json()).catch(e => { throw new Error("Neighborhoods Fetch Failed: " + e) }),
            fetch('/api/schedule').then(r => r.json()).catch(e => { console.warn("Schedule Fetch Failed", e); return null; })
        ]);

        StatusPanel.init();
        StatusPanel.log("Data loaded successfully.");
        StatusPanel.update("routes", Object.keys(config.routes).length);

        // 1. Neighborhoods (Quick inline render for now)
        L.geoJSON(neighborhoodsRes, {
            style: { color: '#38bdf8', weight: 1, opacity: 0.3, fillColor: '#0f172a', fillOpacity: 0.1 }
        }).addTo(layers.neighborhoods);

        // 2. Lines (from Backend)
        let renderedShapes = config.shapes; // Fallback
        try {
            console.log("Rendering Subway Lines...");
            const result = renderSubwayLines(map, config.shapes, config.routes);
            if (result) renderedShapes = result;
        } catch (e) {
            console.error("Line Rendering Failed:", e);
            // Don't throw, just use original shapes if render fails
        }

        // 3. Stations (from Local)
        try {
            StatusPanel.log("Rendering Stations...");
            renderStations(stationsRes, layers.stations, scheduleRes, config.routes);
            StatusPanel.update("stations", stationsRes.features ? stationsRes.features.length : 0);
        } catch (e) { throw new Error("Station Rendering Failed: " + e.message); }

        // 4. Update Legend
        try {
            updateLegendLines(config.routes, toggleRouteLayer);
        } catch (e) { console.error("Legend Update Failed", e); }

        // 5. Start Animation
        try {
            if (scheduleRes) {
                console.log("Starting animation with filter:", visibilityFilter);
                // Use renderedShapes so trains snap to visual lines
                startTrainAnimation(renderedShapes, config.routes, scheduleRes, visibilityFilter);
            } else {
                console.warn("Schedule fetch failed or returned null, skipping animation.");
            }
        } catch (e) {
            console.error("Animation Failed", e);
        }

    } catch (err) {
        // If critical fetch fails
        console.error("CRITICAL BOOT ERROR:", err);
        alert(`CRITICAL ERROR:\n${err.message}`);
    } finally {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('fade-out');
            setTimeout(() => loadingOverlay.style.display = 'none', 500);
        }
    }
}

document.addEventListener('DOMContentLoaded', runApp);
