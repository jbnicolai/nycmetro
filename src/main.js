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
        window.startupMetrics = { fetchStart: performance.now() };
        console.time("StartupToLive");

        // 1. Critical Fetch: Start EVERYTHING in parallel immediately
        console.log("Starting eager data prefetch...");
        const dataPromises = {
            config: fetchConfig().catch(e => { throw new Error("Config Fetch Failed: " + e) }),
            stations: fetch('./data/subway-stations.geojson').then(r => r.json()).catch(e => { throw new Error("Stations Fetch Failed: " + e) }),
            neighborhoods: fetch('./data/nyc-neighborhoods.geojson').then(r => r.json()).catch(e => { throw new Error("Neighborhoods Fetch Failed: " + e) }),
            schedule: fetch('/api/schedule').then(r => r.json()).catch(e => { throw new Error("Schedule Fetch Failed: " + e) }),
            realtime: initRealtime().catch(e => { throw new Error("Realtime Init Failed: " + e) })
        };

        const mapReady = new Promise(resolve => {
            let fired = false;
            const done = () => { if (!fired) { fired = true; resolve(performance.now()); } };
            map.once('moveend', done);
            setTimeout(done, 4000); // Guard timeout
        });

        // 2. Trigger Auto-Locate IMMEDIATELY 
        if (window.triggerLocate) {
            window.triggerLocate();
        }

        // Resolve core data (Parallel with map animation)
        const [config, stationsRes, neighborhoodsRes] = await Promise.all([
            dataPromises.config,
            dataPromises.stations,
            dataPromises.neighborhoods
        ]);
        window.startupMetrics.coreDataReady = performance.now();
        console.log(`Core data ready in ${Math.round(window.startupMetrics.coreDataReady - window.startupMetrics.fetchStart)}ms`);

        StatusPanel.init();
        StatusPanel.update("routes", Object.keys(config.routes).length);

        // --- PHASE 2: UI Transitions & Background Rendering ---
        // We render these even if the map is still zooming! 
        // Leaflet's Canvas handles this gracefully.

        // Neighborhoods
        L.geoJSON(neighborhoodsRes, {
            style: { color: '#38bdf8', weight: 1, opacity: 0.3, fillColor: '#0f172a', fillOpacity: 0.1 },
            pane: 'neighborhoodsPane'
        }).addTo(layers.neighborhoods);

        // Subway Lines & Legend
        const lineResult = await renderSubwayLines(map, config.shapes, config.routes);
        let renderedShapes = lineResult || config.shapes;
        updateLegendLines(config.routes, toggleRouteLayerBatch);

        // Stations
        renderStations(stationsRes, layers.stations, null, config.routes);
        StatusPanel.update("stations", stationsRes.features ? stationsRes.features.length : 0);

        // Utility: Smoothly Reveal Panes
        const reveal = (paneName) => {
            const pane = map.getPane(paneName + 'Pane');
            if (pane) {
                pane.classList.remove('layer-hidden');
                pane.classList.add('layer-visible');
            }
        };

        // Reveal background layers early
        setTimeout(() => reveal('neighborhoods'), 100);
        setTimeout(() => reveal('routes'), 300);

        // --- OPTIMIZATION: Start fading overlay WHILE map is still settling ---
        const loadingOverlay = document.getElementById('loading-overlay');
        const trainLoader = document.getElementById('train-loading');

        // Wait at least 1s for the zoom to start feeling "smooth" but reveal map before it's totally done
        setTimeout(() => {
            if (loadingOverlay) {
                loadingOverlay.classList.add('fade-out');
                setTimeout(() => loadingOverlay.style.display = 'none', 800);
            }
        }, 1200);

        // Wait for Map to settle 
        await mapReady;
        window.startupMetrics.mapReady = performance.now();
        console.log(`[Metric] Map ready in ${Math.round(window.startupMetrics.mapReady - window.startupMetrics.fetchStart)}ms`);

        // PHASE 3: Synchronized Live Activation
        if (trainLoader) trainLoader.classList.remove('hidden');

        StatusPanel.log(`[${Math.round(performance.now() - window.startupMetrics.fetchStart)}ms] Syncing Live Data...`);
        const [scheduleRes] = await Promise.all([dataPromises.schedule, dataPromises.realtime]);
        window.startupMetrics.liveDataReady = performance.now();

        // Re-render stations with schedule data and fade them in
        layers.stations.clearLayers();
        renderStations(stationsRes, layers.stations, scheduleRes, config.routes);
        reveal('stations');

        // Start Animation
        StatusPanel.log(`[${Math.round(performance.now() - window.startupMetrics.fetchStart)}ms] Starting Animation...`);
        if (trainLoader) trainLoader.classList.remove('hidden'); // Ensure spinner is active during heavy scan
        await startTrainAnimation(renderedShapes, config.routes, scheduleRes, visibilityFilter);
        reveal('trains');


        window.startupMetrics.liveAnimationStart = performance.now();
        console.timeEnd("StartupToLive");
        console.log("Startup Final Metrics:", window.startupMetrics);

        if (trainLoader) trainLoader.classList.add('hidden');

    } catch (err) {
        console.error("CRITICAL BOOT ERROR:", err);
        alert(`CRITICAL ERROR:\n${err.message}`);
    }
}

document.addEventListener('DOMContentLoaded', runApp);
