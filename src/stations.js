import { parseProperties, formatTime } from './utils.js';
import { rtState } from './realtime.js';
import { getActiveAlerts } from './alerts.js';

let stationScheduleIndex = null;
let rawSchedule = null;

// Pre-process schedule: { stationId_base: { N: [], S: [] } }
function buildStationScheduleIndex(schedule) {
    if (!schedule || !schedule.routes) return;
    rawSchedule = schedule;
    stationScheduleIndex = {};

    console.log("Building Station Schedule Index...");
    Object.keys(schedule.routes).forEach(routeId => {
        const trips = schedule.routes[routeId];
        trips.forEach(trip => {
            trip.stops.forEach(stop => {
                const baseId = stop.id.substring(0, 3); // e.g., "101N" -> "101"
                const dir = stop.id.slice(-1); // "N" or "S"

                if (!stationScheduleIndex[baseId]) {
                    stationScheduleIndex[baseId] = { N: [], S: [] };
                }

                // Store stop info
                if (stationScheduleIndex[baseId][dir]) {
                    stationScheduleIndex[baseId][dir].push({
                        routeId: routeId,
                        time: stop.time,
                        tripId: trip.tripId
                    });
                }
            });
        });
    });

    // Sort all by time
    Object.values(stationScheduleIndex).forEach(dirs => {
        ['N', 'S'].forEach(d => {
            dirs[d].sort((a, b) => a.time - b.time);
        });
    });
    console.log("Station Index Built.");
}

// Helper to match GeoJSON station to Schedule Stop ID by proximity
function matchStationId(lat, lng, stops) {
    if (!stops) return null;
    let minDistSq = Infinity;
    let bestId = null;
    // Threshold: ~300m (approx 0.003 degrees)
    const THRESHOLD = 0.003 ** 2;

    // We only need to check parent IDs (often 3 chars like '101') or just all.
    // The schedule index uses base IDs (first 3 chars).
    // The 'stops' object keys include '101', '101N', '101S'. 
    // We prefer the numeric timestamp based IDs if possible or just the base.
    // Let's iterate all.

    for (const [id, data] of Object.entries(stops)) {
        // data is [lat, lon, name]
        const [sLat, sLon] = data;
        const dSq = (lat - sLat) ** 2 + (lng - sLon) ** 2;
        if (dSq < minDistSq) {
            minDistSq = dSq;
            bestId = id;
        }
    }

    return minDistSq < THRESHOLD ? bestId : null;
}

// Helper to get text color based on background (simple brightness check)
function getContrastColor(hexColor) {
    if (!hexColor) return '#000';
    // Convert hex to rgb
    const r = parseInt(hexColor.substr(1, 2), 16);
    const g = parseInt(hexColor.substr(3, 2), 16);
    const b = parseInt(hexColor.substr(5, 2), 16);
    // YIQ equation
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#ffffff';
}

let routeConfigs = {};

let activeHighlightLayers = [];

export function renderStations(geoJson, layerGroup, schedule, routes) {
    if (schedule && !stationScheduleIndex) {
        buildStationScheduleIndex(schedule);
    }
    if (routes) {
        routeConfigs = routes;
    }

    // 1. Group features into bundles (Same Name + Proximity < 300m)
    const bundles = [];

    if (!geoJson || !geoJson.features) return;

    geoJson.features.forEach(feature => {
        if (!feature.geometry || !feature.geometry.coordinates) return;

        const [lng, lat] = feature.geometry.coordinates; // GeoJSON is Lng, Lat
        if (isNaN(lat) || isNaN(lng)) return;

        const latlng = L.latLng(lat, lng);
        const { name } = parseProperties(feature); // Ensure utility is imported or just use properties

        // Try to match station ID early (needed for everything else)
        if (schedule && schedule.stops && !feature.properties.gtfs_stop_id) {
            const matchedId = matchStationId(lat, lng, schedule.stops);
            if (matchedId) {
                feature.properties.gtfs_stop_id = matchedId;
            }
        }

        // Find matching bundle
        let added = false;
        for (const bundle of bundles) {
            // Check name and distance to the first element's position
            // Simple Euclidian approximation or Leaftlet distanceTo
            const leader = bundle[0];
            if (leader.name === name) {
                const dist = leader.latlng.distanceTo(latlng);
                if (dist < 300) { // 300 meters threshold
                    bundle.push({ feature, latlng, name });
                    added = true;
                    break;
                }
            }
        }

        if (!added) {
            bundles.push([{ feature, latlng, name }]);
        }
    });

    // 2. Render Bundles
    bundles.forEach(bundle => {
        const bundleLayers = [];

        // Create markers for each item in bundle
        bundle.forEach(item => {
            const marker = L.circleMarker(item.latlng, {
                radius: 3,
                fillColor: '#ffffff',
                color: '#000',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            });

            // Basic Tooltip
            marker.bindTooltip(item.name, { direction: 'top', className: 'subway-label' });

            // Add to map layer group
            marker.addTo(layerGroup);
            bundleLayers.push(marker);
        });

        // Bind Click Event to ALL layers in the bundle
        bundleLayers.forEach(layer => {
            layer.on('click', () => {
                highlightBundle(bundleLayers);
                // Pass all features in the bundle to the popup generator
                // Use the clicked layer as the anchor
                showStationPopup(bundle.map(b => b.feature), layer);
            });
        });
    });
}

function highlightBundle(layers) {
    // Reset previous
    activeHighlightLayers.forEach(l => {
        if (l) l.setStyle({ radius: 3, color: '#000', weight: 1, fillColor: '#ffffff' });
    });
    activeHighlightLayers = [];

    // Highlight new
    layers.forEach(l => {
        l.setStyle({ radius: 6, color: '#fbbf24', weight: 3, fillColor: '#ffffff' });
        l.bringToFront();
    });
    activeHighlightLayers = layers;
}

function showStationPopup(features, layer) {
    if (!features || features.length === 0) return;

    // Aggregate Data
    const name = parseProperties(features[0]).name; // Use first name
    const stopIds = new Set();

    features.forEach(f => {
        let id = f.properties.gtfs_stop_id || f.properties.stop_id;
        if (id && id.length > 3) id = id.substring(0, 3);
        if (id) stopIds.add(id);
    });

    // Current Time
    const now = new Date();
    const secondsSinceMidnight =
        now.getHours() * 3600 +
        now.getMinutes() * 60 +
        now.getSeconds();

    let content = `<div style="min-width: 250px;">
        <h3 style="margin-top:0; margin-bottom:5px; padding-bottom:5px;">${name}</h3>`;

    let dataFound = false;
    let northList = [];
    let southList = [];
    let allRoutes = new Set();

    if (stationScheduleIndex && stopIds.size > 0) {
        stopIds.forEach(sid => {
            if (stationScheduleIndex[sid]) {
                const d = stationScheduleIndex[sid];
                // Collect Routes
                d.N.forEach(t => allRoutes.add(t.routeId));
                d.S.forEach(t => allRoutes.add(t.routeId));
                // Collect Trains
                northList = northList.concat(d.N);
                southList = southList.concat(d.S);
                dataFound = true;
            }
        });

        // Add Route Badges to Header (immediately after collecting allRoutes)
        if (allRoutes.size > 0) {
            const badges = Array.from(allRoutes).sort().map(rid => {
                const color = routeConfigs[rid] ? routeConfigs[rid].color : '#666';
                const textColor = getContrastColor(color);
                return `<span style="background-color:${color}; color:${textColor}; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.8em; margin-right:4px;">${rid}</span>`;
            }).join('');
            content += `<div style="margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #ddd;">${badges}</div>`;
        } else {
            content += `<div style="border-bottom:1px solid #ddd; margin-bottom:10px;"></div>`;
        }

        // Helper to find RT data
        const getRealtimeData = (tripId) => {
            if (rtState.mode !== 'REALTIME') return null;
            // Strict
            if (rtState.trips.has(tripId)) return rtState.trips.get(tripId);
            // Fuzzy
            const parts = tripId.split('..');
            if (parts.length >= 2) {
                const key = parts[0] + '_' + parts[1][0];
                if (rtState.fuzzyTrips.has(key)) return rtState.fuzzyTrips.get(key);
            }
            return null;
        };

        // Helper to calculate delay
        const getTripDelay = (tripId, rt) => {
            if (!rt || !rawSchedule || !rawSchedule.routes) return 0;
            const routeTrips = rawSchedule.routes[rt.routeId];
            if (!routeTrips) return 0;

            // Find the trip setup in schedule
            const trip = routeTrips.find(tr => tr.tripId === tripId);
            if (!trip) return 0;

            const currentStop = trip.stops.find(s => s.id === rt.stopId);
            if (!currentStop) return 0;

            // Normalize RT Time (Unix Epoch) to Seconds Since Midnight local time
            const rtDate = new Date(rt.time * 1000);
            const rtSeconds = rtDate.getHours() * 3600 + rtDate.getMinutes() * 60 + rtDate.getSeconds();

            // Handle potential day wrapping comparison
            let diff = rtSeconds - currentStop.time;
            if (diff < -43200) diff += 86400;
            if (diff > 43200) diff -= 86400;

            return diff;
        };

        // Filter & Sort Merged Lists with Live Data
        const filterAndSort = (list) => {
            return list
                .map(t => {
                    const rt = getRealtimeData(t.tripId);
                    let delay = 0;
                    let isLive = false;

                    if (rt) {
                        delay = getTripDelay(t.tripId, rt);
                        isLive = true;
                    }

                    return { ...t, predictedTime: t.time + delay, isLive, rt };
                })
                .filter(t => t.predictedTime >= secondsSinceMidnight) // Filter by PREDICTED time
                .sort((a, b) => a.predictedTime - b.predictedTime)
                .slice(0, 5);
        };

        northList = filterAndSort(northList);
        southList = filterAndSort(southList);
    }

    // --- Alerts ---
    const activeAlerts = getActiveAlerts();
    const stationAlerts = activeAlerts.filter(alert =>
        alert.routes.some(r => allRoutes.has(r))
    );

    if (stationAlerts.length > 0) {
        content += `<div style="background:#451a03; border:1px solid #f59e0b; border-radius:4px; padding:6px; margin-bottom:10px;">
            <strong style="color:#fbbf24; font-size:0.8em; display:block; margin-bottom:4px;">⚠️ Service Alerts</strong>`;

        stationAlerts.forEach(alert => {
            const affectedAtStation = alert.routes.filter(r => allRoutes.has(r)).join(', ');
            content += `<div style="font-size:0.75em; color:#fff; margin-bottom:4px; line-height:1.2;">
                <span style="color:#fbbf24">[${affectedAtStation}]</span> ${alert.header}
            </div>`;
        });
        content += `</div>`;
    }
    // --------------

    if (dataFound) {
        const renderRow = (t) => {
            const routeId = t.routeId;
            const color = routeConfigs[routeId] ? routeConfigs[routeId].color : '#666';
            const textColor = getContrastColor(color);

            // Real-Time Logic
            let displayTime = t.predictedTime; // Use predicted
            let statusBadge = "";
            let timeClass = "color:#555;";

            if (t.isLive) {
                // Check if stopped at current station
                const rt = t.rt;
                const isAtStation = Array.from(stopIds).some(baseId => rt.stopId.startsWith(baseId));

                if (isAtStation) {
                    statusBadge = `<span style="color:#ef4444; font-weight:bold; font-size:0.8em; margin-right:4px;">● At Station</span>`;
                    timeClass = "color:#000; font-weight:bold;";
                } else {
                    const delayMins = Math.round((t.predictedTime - t.time) / 60);
                    let delayText = "Live";
                    let delayColor = "#22c55e"; // Green

                    if (delayMins > 2) {
                        delayText = `+${delayMins} min`;
                        delayColor = "#ef4444"; // Red
                    } else if (delayMins < -2) {
                        delayText = `${delayMins} min`;
                    }

                    statusBadge = `<span style="color:${delayColor}; font-size:0.8em; margin-right:4px;">📶 ${delayText}</span>`;
                }
            }

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.9em; margin-bottom:4px;">
                <span style="
                    background-color: ${color}; 
                    color: ${textColor}; 
                    padding: 2px 6px; 
                    border-radius: 4px; 
                    font-weight: bold; 
                    min-width: 24px; 
                    text-align: center;
                    display: inline-block;
                ">${routeId}</span>
                <div style="text-align:right;">
                    ${statusBadge}
                    <span style="font-family:monospace; ${timeClass}">${formatTime(displayTime)}</span>
                </div>
            </div>`;
        };

        content += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
            <div>
                <strong style="font-size:0.75em; text-transform:uppercase; color:#888; display:block; margin-bottom:6px;">Northbound</strong>
                ${northList.length ? northList.map(renderRow).join('') : '<div style="color:#aaa; font-size:0.8em; font-style:italic;">No trains</div>'}
            </div>
            <div>
                <strong style="font-size:0.75em; text-transform:uppercase; color:#888; display:block; margin-bottom:6px;">Southbound</strong>
                ${southList.length ? southList.map(renderRow).join('') : '<div style="color:#aaa; font-size:0.8em; font-style:italic;">No trains</div>'}
            </div>
        </div>`;

    } else {
        content += `<div style="color:#666; font-size:0.8em; margin-top:5px;"><em>No schedule data available.</em></div>`;
    }

    content += `</div>`;

    layer.bindPopup(content).openPopup();
}
