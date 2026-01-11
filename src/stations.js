import { parseProperties, formatTime, getDelayInSeconds } from './utils.js';
import { rtState, getMatchingTrip } from './realtime.js';
import { getActiveAlerts } from './alerts.js';
import { renderRouteBadge, renderStatusBadge } from './ui.js';

// ... (imports)

// Remove local getContrastColor helper (lines 114-123)

// ...

export let stationScheduleIndex = null;
let rawSchedule = null;
// Store markers for jumping
const stationMarkers = new Map();





// Expose global jumper
window.flyToStation = (stationId) => {
    // Try to find by base ID
    // Try to find by base ID
    let marker = stationMarkers.get(stationId);
    if (!marker) {
        // Try stripping direction suffix (e.g. "125S" -> "125")
        const base = stationId.replace(/[NS]$/, '');
        marker = stationMarkers.get(base);
    }

    if (!marker) {
        // Try fuzzy? iterating map is slow but robust if needed
        console.warn("Station not found:", stationId);
        return;
    }

    // Fly to it
    const map = marker._map; // Leaflet layer has _map if added
    if (map) {
        map.flyTo(marker.getLatLng(), 15, { animate: true, duration: 1.2 });
        marker.fire('click'); // Trigger popup
    }
};



function buildStationScheduleIndex(schedule) {
    if (!schedule || !schedule.routes) return;
    rawSchedule = schedule;
    stationScheduleIndex = {};

    console.log("Building Station Schedule Index...");
    Object.keys(schedule.routes).forEach(routeId => {
        const trips = schedule.routes[routeId];
        trips.forEach(trip => {
            trip.stops.forEach(stop => {
                const baseId = stop.id.substring(0, 3);
                const dir = stop.id.slice(-1);

                if (!stationScheduleIndex[baseId]) {
                    stationScheduleIndex[baseId] = { N: [], S: [] };
                }

                if (stationScheduleIndex[baseId][dir]) {
                    // Simple De-duplication: check if we already have this route at this time
                    // (Assuming duplicates are due to multiple service_ids for different days)
                    const existing = stationScheduleIndex[baseId][dir].find(
                        item => item.routeId === routeId && item.time === stop.time
                    );

                    if (!existing) {
                        stationScheduleIndex[baseId][dir].push({
                            routeId: routeId,
                            time: stop.time,
                            tripId: trip.tripId
                        });
                    }
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

            // Index for jumping
            const sId = item.feature.properties.gtfs_stop_id;
            if (sId) {
                stationMarkers.set(sId, marker);
            }

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

    let content = `<div class="station-popup">
        <div class="station-header">
            <h3 class="station-title">${name}</h3>`;

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

        // Add Route Badges to Header
        let badgesHtml = '';
        if (allRoutes.size > 0) {
            badgesHtml = Array.from(allRoutes).sort().map(rid => {
                const color = routeConfigs[rid] ? routeConfigs[rid].color : '#666';
                const textColor = getContrastColor(color);
                return `<span class="station-badge" style="background-color:${color}; color:${textColor};">${rid}</span>`;
            }).join('');
        }
        content += `<div class="station-badges">${badgesHtml}</div></div>`; // Close Header

        // Helper to calculate delay (Restored)
        const getTripDelay = (tripId, rt) => {
            if (!rt || !rawSchedule || !rawSchedule.routes) return 0;
            const routeTrips = rawSchedule.routes[rt.routeId];
            if (!routeTrips) return 0;

            // Find the trip setup in schedule
            const trip = routeTrips.find(tr => tr.tripId === tripId);
            if (!trip) return 0;

            // Check if RT stop is valid for this trip
            const currentStop = trip.stops.find(s => s.id === rt.stopId);
            if (!currentStop) return 0;

            return getDelayInSeconds(rt, currentStop);
        };

        // Filter & Sort Merged Lists with Live Data
        const filterAndSort = (list) => {
            return list
                .map(t => {
                    const rt = getMatchingTrip(t.tripId, t.routeId);
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
                // Render-side Deduplication
                .filter((t, index, self) => {
                    // Check if there is a previous element with same RouteID and very similar time
                    const prev = self[index - 1];
                    if (!prev) return true;
                    if (prev.routeId === t.routeId && Math.abs(prev.predictedTime - t.predictedTime) < 120) {
                        return false; // Skip duplicate
                    }
                    return true;
                })
                .slice(0, 5);
        };

        northList = filterAndSort(northList);
        southList = filterAndSort(southList);
    } else {
        content += `</div>`; // Close Header if no data
    }

    // --- Alerts ---
    const activeAlerts = getActiveAlerts();
    const stationAlerts = activeAlerts.filter(alert =>
        alert.routes.some(r => allRoutes.has(r))
    );

    if (stationAlerts.length > 0) {
        content += `<div style="background:#451a03; border-bottom:1px solid #f59e0b; padding:10px;">
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
            const config = routeConfigs[routeId];
            const badgeHtml = renderRouteBadge(routeId, config);

            // 2. Status
            let statusBadge = "";
            let displayTime = t.predictedTime;

            if (t.isLive) {
                const rt = t.rt;
                const isAtStation = Array.from(stopIds).some(baseId => rt.stopId.startsWith(baseId));
                const isStopped = rt.currentStatus === 'STOPPED_AT' || rt.currentStatus === 1;
                const delayMins = Math.round((t.predictedTime - t.time) / 60);

                let effectiveAtStation = false;
                if (isAtStation) {
                    if (isStopped) effectiveAtStation = true;
                    else if (Math.abs((t.predictedTime - t.time) / 60) <= 2) effectiveAtStation = true;
                }

                statusBadge = renderStatusBadge(t.isLive, delayMins, effectiveAtStation, isStopped);

            } else {
                statusBadge = renderStatusBadge(false, 0, false, false);
            }

            return `
            <div class="arrival-row clickable-row" onclick="window.flyToTrain('${t.tripId}')">
                <div class="arrival-left">
                    ${badgeHtml}
                    ${statusBadge}
                </div>
                <div class="arrival-right">
                    <span class="time-primary">${formatTime(displayTime)}</span>
                </div>
            </div>`;
        };


        content += `<div class="station-body">
            <div class="station-dir-col">
                <div class="dir-header">Northbound</div>
                ${northList.length ? northList.map(renderRow).join('') : '<div class="no-trains">No trains nearby</div>'}
            </div>
            <div class="station-dir-col">
                <div class="dir-header">Southbound</div>
                ${southList.length ? southList.map(renderRow).join('') : '<div class="no-trains">No trains nearby</div>'}
            </div>
        </div>`;

    } else {
        content += `<div class="station-body"><div class="no-trains">No schedule data available.</div></div>`;
    }

    content += `</div>`; // Close station-popup

    layer.bindPopup(content, { maxWidth: 420, minWidth: 340 }).openPopup();
}
