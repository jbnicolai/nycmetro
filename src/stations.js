import { parseProperties, formatTime, getDelayInSeconds, unixToSecondsSinceMidnight, yieldToMain, normId, STATION_ALIASES } from './utils.js';
import { rtState, getMatchingTrip, getScheduledIdForRt } from './realtime.js';
import { getActiveAlerts } from './alerts.js';
import { renderRouteBadge, renderStatusBadge } from './ui.js';
import { updateHash } from './history.js';

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
    let marker = stationMarkers.get(stationId);
    if (!marker) {
        // Try stripping direction suffix (e.g. "125S" -> "125")
        const base = stationId.replace(/[NS]$/, '');
        marker = stationMarkers.get(base);
    }

    if (!marker) {
        console.warn("Station not found:", stationId);
        return;
    }

    // Fly to it
    const map = marker._map;
    if (map) {
        const latlng = marker.getLatLng();

        // Mobile Offset Logic:
        // Position the station in the bottom 75% (approx) so the popup (opening upwards)
        // has space below the top search bar.
        // We calculate a new center point that is "above" the station.

        const isMobile = window.innerWidth <= 600;
        let targetLatLng = latlng;

        if (isMobile) {
            // Project to pixel coordinates at current zoom (or target zoom 15)
            const zoom = 15;
            const point = map.project(latlng, zoom);

            // Shift the center UP by 25% of screen height (placing station 25% down from center -> 75% down from top)
            // Wait, coordinate system: (0,0) top-left.
            // Screen Height H.
            // Center is H/2. 
            // We want station at 0.75 * H.
            // So pixel offset = 0.75*H - 0.5*H = 0.25*H (positive Y = down).
            // So the center needs to be shifted UP relative to station? 
            // No, the station needs to be below center.
            // Center Y = Station Y - Offset.

            const offsetY = map.getSize().y * 0.25; // 1/4 screen height
            const targetPoint = point.subtract([0, offsetY]); // Shift target center UP
            targetLatLng = map.unproject(targetPoint, zoom);
        }

        // Delay popup slightly to allow move start
        setTimeout(() => {
            if (marker._features) {
                showStationPopup(marker._features, marker);
            } else {
                marker.openPopup();
            }
        }, 100);
    }
};



async function buildStationScheduleIndex(schedule) {
    if (!schedule || !schedule.routes) return;
    rawSchedule = schedule;
    stationScheduleIndex = {};
    const seenKeys = new Set();

    console.log("Building Station Schedule Index...");
    console.time("BuildStationIndex");
    const routeIds = Object.keys(schedule.routes);
    let tripCount = 0;
    let yieldCounter = 0;

    for (const routeId of routeIds) {
        const trips = schedule.routes[routeId];
        for (const trip of trips) {
            tripCount++;

            // Yield every 50 trips to keep UI responsive
            if (++yieldCounter % 50 === 0) await yieldToMain();

            trip.stops.forEach(stop => {
                const baseId = stop.id.substring(0, 3);
                const dir = stop.id.slice(-1);

                const key = `${baseId}_${dir}_${routeId}_${stop.time}`;
                if (seenKeys.has(key)) return;
                seenKeys.add(key);

                if (!stationScheduleIndex[baseId]) {
                    stationScheduleIndex[baseId] = { N: [], S: [] };
                }

                if (stationScheduleIndex[baseId][dir]) {
                    stationScheduleIndex[baseId][dir].push({
                        routeId: routeId,
                        time: stop.time,
                        tripId: trip.tripId
                    });
                }
            });
        }
    }

    // Sort all by time
    Object.values(stationScheduleIndex).forEach(dirs => {
        ['N', 'S'].forEach(d => {
            dirs[d].sort((a, b) => a.time - b.time);
        });
    });
    console.timeEnd("BuildStationIndex");
    console.log(`Station Index Built: ${tripCount} trips processed.`);
}

// Helper to match GeoJSON station to Schedule Stop ID by proximity
function matchStationId(lat, lng, stops) {
    if (!stops) return null;
    let minDistSq = Infinity;
    let bestId = null;
    const THRESHOLD = 0.003 ** 2;

    for (const [id, data] of Object.entries(stops)) {
        // data is [lat, lon, name]
        // Skip specific platform IDs for speed if possible, but here we need a broad check
        // NYC GTFS parent stations are usually 3 chars. 
        if (id.length > 3) continue;

        const dSq = (lat - data[0]) ** 2 + (lng - data[1]) ** 2;
        if (dSq < minDistSq) {
            minDistSq = dSq;
            bestId = id;
        }
    }

    return minDistSq < THRESHOLD ? bestId : null;
}

let routeConfigs = {};


// Helper to get incoming trains merging RT and Schedule
function getIncomingTrains(stopIds, direction) {
    const results = [];
    const currentSeconds = unixToSecondsSinceMidnight(Date.now() / 1000);

    if (results.length === 0) {
        // console.log(`Station ${Array.from(stopIds)[0]} [${direction}] scanning at t=${currentSeconds}`);
    }

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
                            routeId: normId(trip.routeId),
                            predictedTime: secs,
                            isLive: true,
                            rt: trip
                        });
                    }
                }
            }
        }
    });

    // 2. Schedule Fallback (Route Isolation)
    if (stationScheduleIndex) {
        stopIds.forEach(stopId => {
            const scheduleObj = stationScheduleIndex[stopId];
            if (scheduleObj) {
                const dirSchedule = scheduleObj[direction]; // 'N' or 'S'

                if (dirSchedule) {
                    // STRICT ISOLATION: 
                    // If we have ANY live trains for this route/station, ignore schedule entirely.
                    const liveRoutes = new Set(results.map(r => r.routeId));

                    dirSchedule.forEach(s => {
                        const sRouteId = normId(s.routeId);
                        if (liveRoutes.has(sRouteId)) return;

                        let t = s.time;
                        const diff = t - currentSeconds;
                        const adjDiff = (diff < -43200) ? diff + 86400 : (diff > 43200) ? diff - 86400 : diff;

                        // UNION STRATEGY:
                        // Since we have strict isolation above, we just check time window.

                        if (adjDiff > -300 && adjDiff < 7200) {
                            // De-duplicate:
                            // 1. Exact Trip ID Match (rare if RT IDs are complex)
                            // 2. Time Match (if live train is within 2 mins of schedule)
                            const alreadyIn = results.some(r =>
                                (r.tripId === s.tripId) ||
                                (r.routeId === sRouteId && Math.abs(r.predictedTime - t) < 120)
                            );

                            if (!alreadyIn) {
                                results.push({
                                    tripId: s.tripId,
                                    routeId: sRouteId,
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

export async function renderStations(geoJson, layerGroup, schedule, routes) {
    if (schedule && !stationScheduleIndex) {
        await buildStationScheduleIndex(schedule);
    }
    if (routes) {
        routeConfigs = routes;
    }

    // 1. Group features into bundles (Same Name + Proximity < 300m)
    const bundles = [];

    if (!geoJson || !geoJson.features) return;

    let featureCounter = 0;
    for (const feature of geoJson.features) {
        if (++featureCounter % 50 === 0) await yieldToMain();

        if (!feature.geometry || !feature.geometry.coordinates) continue;

        const [lng, lat] = feature.geometry.coordinates; // GeoJSON is Lng, Lat
        if (isNaN(lat) || isNaN(lng)) continue;

        const latlng = L.latLng(lat, lng);
        const { name } = parseProperties(feature);

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
    }

    // 2. Render Bundles
    bundles.forEach(bundle => {
        const bundleLayers = [];

        // Create markers for each item in bundle
        // Create markers for each item in bundle
        bundle.forEach(item => {
            // Invisible Hit Area (Larger)
            const hitMarker = L.circleMarker(item.latlng, {
                radius: 12, // Larger hit area (24px diameter)
                fillColor: '#ffffff',
                color: 'transparent',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'stationsPane' // Same pane as visible marker
            });

            const marker = L.circleMarker(item.latlng, {
                radius: 4.5,
                fillColor: '#ffffff',
                color: '#000',
                weight: 1.5,
                opacity: 1,
                fillOpacity: 0.8,
                pane: 'stationsPane'
            });

            // Bind Events Handlers
            const openPopup = () => window.flyToStation(item.feature.properties.gtfs_stop_id);

            const bindEvents = (m) => {
                m.bindTooltip(item.name, {
                    direction: 'top',
                    className: 'train-label station-hover-label',
                    offset: [0, -10],
                    opacity: 1,
                    sticky: true
                });
                m.on('click', openPopup);
            };

            bindEvents(hitMarker);
            bindEvents(marker);

            bundleLayers.push(hitMarker);
            bundleLayers.push(marker);

            // Index for jumping
            const sId = item.feature.properties.gtfs_stop_id;
            if (sId) {
                marker._features = bundle.map(b => b.feature); // Store for flyToStation
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

    // 3. Update Search Index
    const searchData = bundles.map(bundle => {
        const item = bundle[0]; // Use leader

        // Aggregate lines from ALL items in the bundle
        const allRoutes = new Set();
        bundle.forEach(bItem => {
            const { lines } = parseProperties(bItem.feature);
            lines.forEach(line => {
                if (line) allRoutes.add(line);
            });
        });

        // Use leader for ID and Name, but aggregated routes
        return {
            id: item.feature.properties.gtfs_stop_id,
            name: item.name,
            routes: Array.from(allRoutes)
        };
    });

    if (window.stationSearch) {
        window.stationSearch.updateIndex(searchData, routeConfigs);
    }
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

            // Add Aliases (e.g. if map has 230, also check 229)
            if (STATION_ALIASES[id]) {
                const alias = STATION_ALIASES[id];
                stopIds.add(alias);
                stopIds.add(alias + 'N');
                stopIds.add(alias + 'S');
            }
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

    // Check Global Live Status (Only count future/recent arrivals)
    const combinedAll = [...northList, ...southList];
    const futureTrains = combinedAll.filter(t => {
        let diff = t.predictedTime - currentSeconds;
        if (diff < -43200) diff += 86400;
        if (diff > 43200) diff -= 86400;
        return diff >= -60; // Ignore trains departed > 1m ago
    });

    // Valid if we have future trains and ALL of them are live
    const allLive = futureTrains.length > 0 && futureTrains.every(t => t.isLive);
    const hasData = futureTrains.length > 0;

    let liveBadgeHtml = '';
    if (allLive) {
        liveBadgeHtml = `<div class="train-realtime-badge">
            <span class="blink-dot" style="background: #10b981;"></span> LIVE
         </div>`;
    } else if (hasData) {
        liveBadgeHtml = `<div class="train-realtime-badge badge-gray">
            SCHEDULED
         </div>`;
    }

    let content = `<div class="station-popup">
        <div class="station-header">
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <h3 class="station-title" style="margin:0;">${name}</h3>
                ${liveBadgeHtml}
            </div>
            <div class="station-routes" style="margin-top:4px;">${badgesHtml}</div>
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

            const safeId = t.tripId.replace(/'/g, "\\'");
            return `
            <div class="arrival-row clickable-row ${rowClass.trim()}" onclick="window.flyToTrain('${safeId}')">
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

        const combinedList = [...northList, ...southList];

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

    // Update URL hash for deep linking
    const stopId = Array.from(stopIds)[0]; // Use first stop ID
    if (stopId) {
        updateHash('station', stopId, { replace: false });
    }

    layer.bindPopup(content, {
        maxWidth: 420,
        minWidth: 340,
        autoPanPaddingTopLeft: L.point(0, 80) // Push map down so header is visible under search bar
    }).openPopup();
}
