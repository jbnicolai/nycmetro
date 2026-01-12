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
import { getInitialState, onHashChange } from './history.js';

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
        const total = stations.length;
        const empty = stations.filter(s => s.num_bikes_available === 0).length;
        const withEbikes = stations.filter(s => s.num_ebikes_available > 0).length;
        const normalOnlyStations = stations.filter(s => {
            const hasBikes = s.num_bikes_available > 0;
            const hasEbikes = s.num_ebikes_available > 0;
            return hasBikes && !hasEbikes;
        }).length;

        const totalBikes = stations.reduce((acc, s) => acc + s.num_bikes_available, 0);

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
                citibikeType: color
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

        // PHASE 1: Eager Prefetch
        console.log("Starting eager data prefetch...");
        const dataPromises = prefetchData();

        const mapReady = new Promise(resolve => {
            let fired = false;
            const done = () => { if (!fired) { fired = true; resolve(performance.now()); } };
            map.once('moveend', done);
            setTimeout(done, 4000);
        });

        // Trigger Auto-Locate immediately 
        if (window.triggerLocate) {
            window.triggerLocate();
        }

        // Resolve core UI data
        const [config, stationsRes, neighborhoodsRes] = await Promise.all([
            dataPromises.config,
            dataPromises.stations,
            dataPromises.neighborhoods
        ]);
        window.startupMetrics.coreDataReady = performance.now();

        StatusPanel.init();
        StatusPanel.update("routes", Object.keys(config.routes).length);

        // PHASE 2: Static Layer Initialization
        await initStaticLayers(map, config, stationsRes, neighborhoodsRes);

        // OPTIMIZATION: Fade overlay while map settles
        const loadingOverlay = document.getElementById('loading-overlay');
        const trainLoader = document.getElementById('train-loading');

        setTimeout(() => {
            if (loadingOverlay) {
                loadingOverlay.classList.add('fade-out');
                setTimeout(() => loadingOverlay.style.display = 'none', 800);
            }
        }, 1200);

        // Wait for Map to settle 
        await mapReady;
        window.startupMetrics.mapReady = performance.now();

        // PHASE 3: Live System Coordination
        if (trainLoader) trainLoader.classList.remove('hidden');

        StatusPanel.log("Syncing Live Data...");
        const [scheduleRes] = await Promise.all([dataPromises.schedule, dataPromises.realtime]);
        window.startupMetrics.liveDataReady = performance.now();

        // Re-render stations with schedule and start animation
        layers.stations.clearLayers();
        await renderStations(stationsRes, layers.stations, scheduleRes, config.routes);
        revealPane(map, 'stations');

        StatusPanel.log("Starting Animation...");
        await startTrainAnimation(config.shapes, config.routes, scheduleRes, visibilityFilter);
        revealPane(map, 'trains');

        window.startupMetrics.liveAnimationStart = performance.now();
        console.timeEnd("StartupToLive");
        console.log("Startup Final Metrics:", window.startupMetrics);

        if (trainLoader) trainLoader.classList.add('hidden');

    } catch (err) {
        console.error("CRITICAL BOOT ERROR:", err);
        alert(`CRITICAL ERROR:\n${err.message}`);
    }
}

function prefetchData() {
    return {
        config: fetchConfig().catch(e => { throw new Error("Config Fetch Failed: " + e) }),
        stations: fetch('./data/subway-stations.geojson').then(r => r.json()).catch(e => { throw new Error("Stations Fetch Failed: " + e) }),
        neighborhoods: fetch('./data/nyc-neighborhoods.geojson').then(r => r.json()).catch(e => { throw new Error("Neighborhoods Fetch Failed: " + e) }),
        schedule: fetch('/api/schedule').then(r => r.json()).catch(e => { throw new Error("Schedule Fetch Failed: " + e) }),
        realtime: initRealtime().catch(e => { throw new Error("Realtime Init Failed: " + e) })
    };
}

async function initStaticLayers(map, config, stationsRes, neighborhoodsRes) {
    // Neighborhoods
    L.geoJSON(neighborhoodsRes, {
        style: { color: '#38bdf8', weight: 1, opacity: 0.3, fillColor: '#0f172a', fillOpacity: 0.1 },
        pane: 'neighborhoodsPane'
    }).addTo(layers.neighborhoods);

    // Subway Lines
    await renderSubwayLines(map, config.shapes, config.routes);
    updateLegendLines(config.routes, toggleRouteLayerBatch);

    // Initial Static Stations (no schedule yet)
    await renderStations(stationsRes, layers.stations, null, config.routes);
    StatusPanel.update("stations", stationsRes.features ? stationsRes.features.length : 0);

    // Reveal background layers
    setTimeout(() => revealPane(map, 'neighborhoods'), 100);
    setTimeout(() => revealPane(map, 'routes'), 300);
}

function revealPane(map, paneName) {
    const pane = map.getPane(paneName + 'Pane');
    if (pane) {
        pane.classList.remove('layer-hidden');
        pane.classList.add('layer-visible');
    }
}

/**
 * Handle initial state from URL hash
 * Called after app initialization to navigate to deep-linked content
 */
function handleInitialState() {
    const state = getInitialState();

    if (!state.type || !state.id) {
        return; // No deep link
    }

    console.log('[DeepLink] Initial state:', state);

    // Navigate to the target
    if (state.type === 'station' && window.flyToStation) {
        window.flyToStation(state.id);
    } else if (state.type === 'train' && window.flyToTrain) {
        window.flyToTrain(state.id);
    }
}

/**
 * Handle hash changes (browser back/forward)
 */
onHashChange((newState, oldState) => {
    console.log('[DeepLink] Hash changed:', oldState, '->', newState);

    // Handle navigation
    if (newState.type === 'station' && newState.id) {
        if (window.flyToStation) {
            window.flyToStation(newState.id);
        }
    } else if (newState.type === 'train' && newState.id) {
        if (window.flyToTrain) {
            window.flyToTrain(newState.id);
        }
    } else {
        // Clear state - close any open popups
        const map = layers.trains._map || layers.stations._map;
        if (map) {
            map.closePopup();
        }
    }
});

document.addEventListener('DOMContentLoaded', () => {
    runApp().then(() => {
        // Handle initial deep link after app is ready
        setTimeout(handleInitialState, 1000);
    });
});
