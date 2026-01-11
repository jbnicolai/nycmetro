import { parseProperties, formatTime, getDelayInSeconds, unixToSecondsSinceMidnight } from './utils.js';
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


// Helper to get incoming trains merging RT and Schedule
function getIncomingTrains(stopIds, direction) {
    const results = [];
    const processedTripIds = new Set();
    const currentSeconds = unixToSecondsSinceMidnight(Date.now() / 1000);

    // 1. RT Scan
    rtState.trips.forEach((trip, tripId) => {
        if (!trip.stopTimeUpdate) return;
        const relevantStop = trip.stopTimeUpdate.find(s => s.stopId && Array.from(stopIds).some(id => s.stopId.startsWith(id)));

        if (relevantStop) {
            // Determine Direction
            const stopDir = relevantStop.stopId.slice(-1);
            let dirMatches = false;
            // Trip direction fallback
            const tripDirChar = trip.directionId === 1 ? 'S' : 'N'; // NYCT: 1=South, 0=North

            if (stopDir === 'N' || stopDir === 'S') {
                dirMatches = (stopDir === direction);
            } else {
                dirMatches = (tripDirChar === direction);
            }

            if (dirMatches) {
                let t = relevantStop.arrival?.time || relevantStop.departure?.time;
                if (t) {
                    const secs = unixToSecondsSinceMidnight(t);
                    const diff = secs - currentSeconds;
                    const adjDiff = (diff < -43200) ? diff + 86400 : (diff > 43200) ? diff - 86400 : diff;

                    if (adjDiff > -300 && adjDiff < 7200) { // Look back 5m, forward 2h
                        results.push({
                            tripId,
                            routeId: trip.routeId,
                            predictedTime: secs,
                            isLive: true,
                            rt: trip
                        });
                        processedTripIds.add(tripId);
                    }
                }
            }
        }
    });

    // 2. Schedule Fallback
    if (stationScheduleIndex) {
        stopIds.forEach(stopId => {
            const scheduleObj = stationScheduleIndex[stopId];
            if (scheduleObj) {
                // scheduleObj is { N: [], S: [] }
                // We only need the direction we are currently looking for
                const dirSchedule = scheduleObj[direction]; // 'N' or 'S'

                if (dirSchedule) {
                    dirSchedule.forEach(s => {
                        if (!processedTripIds.has(s.tripId)) {
                            let t = s.time;
                            const diff = t - currentSeconds;
                            const adjDiff = (diff < -43200) ? diff + 86400 : (diff > 43200) ? diff - 86400 : diff;

                            if (adjDiff > -300 && adjDiff < 7200) { // Look back 5m, forward 2h
                                results.push({
                                    tripId: s.tripId,
                                    routeId: s.routeId,
                                    predictedTime: t,
                                    isLive: false
                                });
                            }
                        }
                    });
                }
            }
        });
    }

    return results.sort((a, b) => {
        let da = a.predictedTime - currentSeconds;
        let db = b.predictedTime - currentSeconds;
        if (da < -43200) da += 86400; if (db < -43200) db += 86400;
        return da - db;
    }); // Removed slice limit
}

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
                radius: 4.5,
                fillColor: '#ffffff',
                color: '#000',
                weight: 1.5,
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

    // Collect Stop IDs
    const stopIds = new Set();
    features.forEach(f => {
        let id = f.properties.gtfs_stop_id || f.properties.stop_id;
        if (id && id.length > 3) id = id.substring(0, 3);
        if (id) {
            stopIds.add(id);
            stopIds.add(id + 'N');
            stopIds.add(id + 'S');
        }
    });

    // Get Data
    const currentSeconds = unixToSecondsSinceMidnight(Date.now() / 1000);
    const filterList = (list) => {
        const departed = [];
        const upcoming = [];
        list.forEach(t => {
            let diff = t.predictedTime - currentSeconds;
            if (diff < -43200) diff += 86400;
            if (diff > 43200) diff -= 86400;
            if (diff < 0) departed.push(t);
            else upcoming.push(t);
        });
        // Keep only last 2 departures (most recent)
        return [...departed.slice(-2), ...upcoming];
    };

    const northList = filterList(getIncomingTrains(stopIds, 'N'));
    const southList = filterList(getIncomingTrains(stopIds, 'S'));
    const dataFound = (northList.length > 0 || southList.length > 0);

    // Calculate Route Badges (Unique routes in the results)
    const allRoutes = new Set();
    northList.forEach(t => allRoutes.add(t.routeId));
    southList.forEach(t => allRoutes.add(t.routeId));

    // Header
    let badgesHtml = '';
    if (allRoutes.size > 0) {
        badgesHtml = Array.from(allRoutes).sort().map(rid => {
            const config = routeConfigs[rid];
            return renderRouteBadge(rid, config);
        }).join('');
    } else {
        // Fallback to static lines if no trains
        const lines = features[0].properties.line || "";
        badgesHtml = lines.split('-').map(r => renderRouteBadge(r, routeConfigs[r])).join('');
    }

    let content = `<div class="station-popup">
        <div class="station-header">
            <h3 class="station-title">${name}</h3>
            <div class="station-routes">${badgesHtml}</div>
        </div>`;

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

    if (dataFound) {
        const currentSeconds = unixToSecondsSinceMidnight(Date.now() / 1000);

        const renderRow = (t, index) => {
            const routeId = t.routeId;
            const config = routeConfigs[routeId];
            const badgeHtml = renderRouteBadge(routeId, config);

            // Time Calc (relative to departure)
            let diff = t.predictedTime - currentSeconds;
            if (diff < -43200) diff += 86400;
            if (diff > 43200) diff -= 86400;

            // Status Logic (Sync with animation.js DWELL_TIME=25)
            let statusBadge = "";
            let rowClass = index >= 5 ? 'hidden-train-row' : '';

            if (diff < 0) {
                // Departed
                const minsAgo = Math.abs(Math.round(diff / 60));
                statusBadge = `<span class="status-badge status-scheduled">Departed ${minsAgo > 0 ? minsAgo + 'm ago' : 'just now'}</span>`;
                rowClass += ' departed-row';
            } else if (diff <= 5) {
                // Departing (last 5s of dwell)
                statusBadge = `<span class="status-badge status-departing">Departing</span>`;
            } else if (diff <= 25) {
                // At Station (dwelling)
                statusBadge = `<span class="status-badge status-at-station">At Station</span>`;
            } else {
                // Arriving / Countdown
                const mins = Math.ceil(diff / 60);
                statusBadge = renderStatusBadge(mins, t.isLive, false);
            }

            return `
            <div class="arrival-row clickable-row ${rowClass.trim()}" onclick="window.flyToTrain('${t.tripId}')">
                <div class="arrival-left">
                    ${badgeHtml}
                    ${statusBadge}
                </div>
                <div class="arrival-right">
                    <span class="time-primary">${formatTime(t.predictedTime)}</span>
                </div>
            </div>`;
        };

        let hasHidden = false;

        const renderList = (list, dirId) => {
            if (list.length === 0) return '<div class="no-trains">No trains nearby</div>';

            return list.map((t, i) => {
                if (i >= 5) hasHidden = true;
                return renderRow(t, i);
            }).join('');
        };

        const northHtml = renderList(northList, 'N');
        const southHtml = renderList(southList, 'S');

        content += `<div class="station-body">
            <div class="station-dir-col">
                <div class="dir-header">Northbound</div>
                <div id="list-N" class="station-list">${northHtml}</div>
            </div>
            <div class="station-dir-col">
                <div class="dir-header">Southbound</div>
                <div id="list-S" class="station-list">${southHtml}</div>
            </div>`;

        if (hasHidden) {
            content += `<div style="grid-column: 1 / -1; margin-top: -10px;">
                <button id="btn-show-more" class="show-more-btn" onclick="
                    const hiddenN = Array.from(document.querySelectorAll('#list-N .hidden-train-row'));
                    const hiddenS = Array.from(document.querySelectorAll('#list-S .hidden-train-row'));
                    
                    const batchN = hiddenN.slice(0, 5);
                    const batchS = hiddenS.slice(0, 5);
                    
                    [...batchN, ...batchS].forEach(el => el.classList.remove('hidden-train-row'));
                    
                    // Check if any remain hidden in either list
                    const remainN = document.querySelectorAll('#list-N .hidden-train-row').length;
                    const remainS = document.querySelectorAll('#list-S .hidden-train-row').length;
                    
                    if (remainN === 0 && remainS === 0) {
                        document.getElementById('btn-show-more').style.display = 'none';
                    }
                ">Show More</button>
             </div>`;
        }

        content += `</div>`;
    } else {
        content += `<div class="station-body"><div class="no-trains">No trains found.</div></div>`;
    }

    content += `</div>`; // Close popup
    layer.bindPopup(content, { maxWidth: 420, minWidth: 340 }).openPopup();
}
