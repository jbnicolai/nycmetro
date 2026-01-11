import { layers } from './map.js';
import { StatusPanel } from './status-panel.js';
import { rtState, getMatchingTrip } from './realtime.js';
import { renderRouteBadge, renderStatusBadge, renderTimelineRow, renderTrainFooter } from './ui.js';
import { formatTime, getDelayInSeconds, getContrastColor, unixToSecondsSinceMidnight } from './utils.js';

// ... (imports)

// Remove local getContrastColor helper at bottom of file if exists (it does)

// Update updateMarkerPopup
function updateMarkerPopup(marker, trip, routeInfo, prev, next, schedule, isRealtime, delay) {
    const getName = (id) => {
        const s = schedule.stops[id];
        return s ? s[2] : id;
    };

    const destName = getName(trip.stops[trip.stops.length - 1].id);
    const routeId = routeInfo.short_name; // or routeInfo.id? usually same for badge

    // Status Badge Logic
    // We need to map our custom rtStatus/delay logic to the helper
    const delayMin = Math.round((delay || 0) / 60);
    const isLive = isRealtime;
    // Animation doesn't explicit track isAtStation/isStopped for popup badge generally, usually just delay?
    // Let's stick to simple "Live (+X min)" using helper if possible, or keep custom if helper insufficient.
    // Helper renderStatusBadge is generic. Let's try to use it.

    // Reuse helper for badge?
    // The helper logic: renderStatusBadge(isLive, delayMins, isAtStation, isStopped)
    // Animation popup usually shows "Live (+X)" in a specific bubble. 
    // The previous code had: <div class="train-realtime-badge">...</div>
    // Let's defer exact UI match or refactor ui.js to support this style.
    // Actually the goal is to UNIFY. So let's use the station-style badge if appropriate, or keep custom.
    // The user liked the "train tooltip overhaul" we just did. 
    // It used: <div class="train-realtime-badge"><span class="blink-dot"></span> Live (+12 min)</div>
    // This is distinct from the station popup badges. 
    // Let's keep the custom realtime badge for trains for now to avoid regression, but use the TIMELINE helpers.

    // 1. Route Badge
    const routeBadgeHtml = renderRouteBadge(routeInfo.short_name, routeInfo);

    // 2. Timeline
    let nextIndex = trip.stops.findIndex(s => s.id === next.id && s.time === next.time);
    if (nextIndex === -1) nextIndex = 0;

    const startIdx = Math.max(0, nextIndex - 3);
    const endIdx = Math.min(trip.stops.length, nextIndex + 5);
    const stopSubset = trip.stops.slice(startIdx, endIdx);

    const rowsHtml = stopSubset.map((stop, i) => {
        const absoluteIndex = startIdx + i;
        const isPast = absoluteIndex < nextIndex;
        const isNext = absoluteIndex === nextIndex;
        const stopName = getName(stop.id);

        // Use generic helper, passing name manually since helper doesn't have schedule access
        return renderTimelineRow({ ...stop, name: stopName }, isNext, isPast, routeInfo.color || '#333', delay);
    }).join('');

    // 3. Footer
    const footerHtml = renderTrainFooter(
        { ...trip.stops[0], name: getName(trip.stops[0].id) },
        { ...trip.stops[trip.stops.length - 1], name: getName(trip.stops[trip.stops.length - 1].id) },
        Math.round((trip.stops[trip.stops.length - 1].time - trip.stops[0].time) / 60)
    );

    // Reconstruct Content
    // RT Status (Custom for now as per "Overhaul")
    let rtStatus = "";
    if (isRealtime) {
        const delayMin = Math.round((delay || 0) / 60);
        let delayText = "";
        if (delayMin > 1) delayText = `<span style="color:#ef4444; margin-left:6px;">(+${delayMin} min)</span>`;
        else if (delayMin < -1) delayText = `<span style="color:#10b981; margin-left:6px;">(${delayMin} min)</span>`;

        rtStatus = `
            <div class="train-realtime-badge">
                <span class="blink-dot"></span> Live ${delayText}
            </div>`;
    }

    const content = `
    <div class="train-popup expanded-popup">
        <div class="train-header">
            <div class="train-title-row">
                ${routeBadgeHtml}
                <span class="train-dest-large">To ${destName}</span>
            </div>
            ${rtStatus}
        </div>
        
        <div class="train-timeline">
            ${rowsHtml}
        </div>

        ${footerHtml}
    </div>`;

    if (marker.getPopup()) {
        marker.setPopupContent(content);
    } else {
        marker.bindPopup(content, {
            className: 'train-leaflet-popup',
            minWidth: 340,
            maxWidth: 360,
            autoPan: false
        });
    }
}

let activeMarkers = {}; // tripId -> Marker
let activeTripIds = new Set(); // tripId set for stats
let animationFrameId;

// Safe Turf Wrapper
const turf = window.turf;

/**
 * Main Entry Point: Start Animation Loop
 */
export function startTrainAnimation(shapes, routes, schedule, visibilitySet) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    // Clear existing
    layers.trains.clearLayers();
    activeMarkers = {};

    // Expose Global Helper
    window.flyToTrain = (tripId) => {
        const marker = activeMarkers[tripId];
        if (marker) {
            const ll = marker.getLatLng();
            const map = marker._map;
            if (map) {
                map.flyTo(ll, 15, { animate: true, duration: 1.2 });
                // Slight delay to allow flyTo to start
                setTimeout(() => marker.openPopup(), 400);
            }
        } else {
            console.warn("Train not found or not active:", tripId);
        }
    };

    if (!turf) {
        console.error("Turf.js not found! Animation disabled.");
        StatusPanel.log("Error: Turf.js missing. Animation stopped.");
        return;
    }

    if (!schedule || !schedule.routes) {
        console.warn("No schedule data available.");
        return;
    }

    StatusPanel.log("Animation Engine Started.");
    console.log("[Schedule] Starting Real-Time Animation...");

    // Index shapes directly for faster lookups based on route_id
    const shapesByRoute = indexShapesByRoute(shapes);

    // Initial State
    let lastFpsUpdate = 0;
    let frameCount = 0;
    let lastLog = 0;

    function animate() {
        const now = new Date();
        const nowMs = now.getTime();

        // Stats: FPS
        frameCount++;
        // Calculate time in seconds since midnight (NYC Time)
        // We use toLocaleString to get NYC time components regardless of browser timezone
        const nycTimeStr = now.toLocaleString("en-US", {
            timeZone: "America/New_York",
            hour12: false,
            hour: "numeric",
            minute: "numeric",
            second: "numeric"
        });

        // Parse "HH:MM:SS" or "24:00:00"
        const [h, m, s] = nycTimeStr.split(':').map(Number);
        const ms = now.getMilliseconds() / 1000;

        const secondsSinceMidnight = (h * 3600) + (m * 60) + s + ms;

        // Also update status panel with NYC time
        if (nowMs - lastFpsUpdate >= 1000) {
            StatusPanel.update("fps", frameCount);

            // Calculate Active Stats
            const total = activeTripIds.size;
            let rtCount = 0;
            let extraCount = 0;
            activeTripIds.forEach(id => {
                if (id.includes && id.includes('..')) { // Crude check for GTFS-RT IDs or check against rtState
                    // Actually, better to check if it matches a known RT trip directly
                    if (rtState.trips.has(id)) rtCount++;
                } else {
                    // Check if this scheduled trip was matched? 
                    // We don't persist "isMatched" easy on ID set.
                    // But rtState.trips usually has the GTFS-RT ID.
                    // If we are strictly using this loop, let's just count total.
                    // Or, we can assume if it's in rtState.trips it might be an extra one if ID matches?
                    // Let's just track "Live" as "Matched+Extra".
                }
            });

            // Re-calc simply:
            const totalRtInFeed = rtState.trips.size;
            // activeTripIds contains both Scheduled (some matched) and Synthetic (all matched).

            // Let's just show Total Active (and maybe label how many are extras?)
            // For now, simple total is fine. "Live" usually meant matched.

            StatusPanel.update("trains", `<span style="color:#fff">${total}</span> <span style="font-size:0.8em; color:#aaa;">(Active)</span>`);
            StatusPanel.update("time", formatTime(secondsSinceMidnight));
            lastFpsUpdate = nowMs;
            frameCount = 0;
        }

        // 1. Identify Valid Trips & Update Positions
        const nextActiveTripIds = new Set();
        const matchedRtTripIds = new Set(); // Track RT trips matched to schedule

        // Check RT Mode
        const useRealtime = rtState.mode === 'REALTIME';

        // Iterate all routes
        const routeIds = Object.keys(schedule.routes);
        for (const routeId of routeIds) {
            // Check visibility
            if (visibilitySet && visibilitySet.has(routeId)) continue;

            const trips = schedule.routes[routeId];
            const routeInfo = routes[routeId] || { color: '#ffffff', short_name: routeId };

            // To prevent duplicates: Collect ALL candidate matches for this route/direction, 
            // then only render the BEST match for each RT trip.
            const candidates = []; // { trip, effectiveTime, isRealtime, rtId, delay, diff }

            for (const trip of trips) {
                const stops = trip.stops;
                if (!stops || stops.length < 2) continue;

                let effectiveTime = secondsSinceMidnight;
                let isRealtime = false;
                let rtId = null;
                let delay = 0;
                let matchDiff = Infinity;

                if (useRealtime) {
                    const rt = getMatchingTrip(trip.tripId, routeId);
                    if (rt) {
                        const scheduledStop = trip.stops.find(s => s.id === rt.stopId);
                        if (scheduledStop && rt.time) {
                            delay = getDelayInSeconds(rt, scheduledStop);
                            effectiveTime -= delay;
                            isRealtime = true;
                            rtId = rt.tripId;

                            // Calculate start time diff for better matching
                            const parts = trip.tripId.split('..');
                            if (parts[0].includes('_')) {
                                const [h, m, s] = parts[0].split('_')[0].match(/.{2}/g).map(Number);
                                const schedStart = h * 3600 + m * 60 + s;
                                matchDiff = Math.abs((rt.startTime || 0) - schedStart);
                            }
                        }
                    }
                }

                if (effectiveTime < stops[0].time || effectiveTime > stops[stops.length - 1].time) {
                    continue;
                }

                candidates.push({ trip, effectiveTime, isRealtime, rtId, delay, matchDiff });
            }

            // Deduplicate: If multiple scheduled trips match the SAME RT trip, 
            // only keep the one with the smallest matchDiff.
            const bestMatches = new Map(); // rtId -> candidate
            const unmatched = [];

            candidates.forEach(c => {
                if (c.rtId) {
                    if (!bestMatches.has(c.rtId) || c.matchDiff < bestMatches.get(c.rtId).matchDiff) {
                        bestMatches.set(c.rtId, c);
                    }
                } else {
                    unmatched.push(c);
                }
            });

            // Render!
            bestMatches.forEach(c => {
                matchedRtTripIds.add(c.rtId);
                nextActiveTripIds.add(c.trip.tripId);
                updateTrainPosition(c.trip, routeId, routeInfo, c.effectiveTime, shapesByRoute, schedule, c.isRealtime, c.delay);
            });

            // Also render unmatched scheduled trips (if desired for fallback)
            unmatched.forEach(c => {
                nextActiveTripIds.add(c.trip.tripId);
                updateTrainPosition(c.trip, routeId, routeInfo, c.effectiveTime, shapesByRoute, schedule, false, 0);
            });
        }

        // 1b. Process Unmatched Real-Time Trips (Extra Trains)
        if (useRealtime) {
            rtState.trips.forEach((rtTrip, tripId) => {
                if (matchedRtTripIds.has(tripId)) return; // Already rendered via schedule

                const routeId = rtTrip.routeId;
                if (visibilitySet && visibilitySet.has(routeId)) return; // Route hidden

                const routeInfo = routes[routeId] || { color: '#ffffff', short_name: routeId };

                // Construct Synthetic Trip
                // We need at least 2 stops to interpolate
                if (!rtTrip.stopTimeUpdate || rtTrip.stopTimeUpdate.length < 2) return;

                let lastTime = -1;
                const syntheticStops = [];
                for (const stu of rtTrip.stopTimeUpdate) {
                    const rawT = stu.arrival?.time || stu.departure?.time;
                    if (!rawT) continue;
                    let t = unixToSecondsSinceMidnight(rawT);

                    // Handle Wrap: If t < lastTime (and diff is large?), add 24h
                    if (lastTime !== -1 && t < lastTime) {
                        t += 86400;
                    }

                    syntheticStops.push({ id: stu.stopId, time: t });
                    lastTime = t;
                }

                if (syntheticStops.length < 2) return;

                const syntheticTrip = {
                    tripId: tripId,
                    stops: syntheticStops,
                    isSynthetic: true
                };

                // Add to active set (ensure cleanup doesn't remove it)
                nextActiveTripIds.add(tripId);

                // Render
                // For synthetic trips, effectiveTime is just current time (delay=0 relative to itself)
                // We check if it's within bounds inside updateTrainPosition (or logic below)
                // Note: We might need to handle 'shapesByRoute' lookup carefully. 
                // If the train is on a route with multiple shapes, finding path segment should still work if stops are standard.
                updateTrainPosition(syntheticTrip, routeId, routeInfo, secondsSinceMidnight, shapesByRoute, schedule, true, 0);
            });
        }

        // 2. Cleanup Old Markers
        for (const tripId in activeMarkers) {
            if (!nextActiveTripIds.has(tripId)) {
                // Train finished or route hidden
                layers.trains.removeLayer(activeMarkers[tripId]);
                delete activeMarkers[tripId];
            }
        }

        // Update Global State
        activeTripIds = nextActiveTripIds;

        // Heartbeat Log
        if (nowMs - lastLog > 10000) {
            // StatusPanel.log(`Active Trains: ${activeTripIds.size}`);
            lastLog = nowMs;
        }

        animationFrameId = requestAnimationFrame(animate);
    }

    animate();
}

/**
 * Updates a single train's position and marker
 */
function updateTrainPosition(trip, routeId, routeInfo, currentTime, shapesByRoute, schedule, isRealtime, delay) {
    // 1. Find Current Segment
    // We want the segment [prev, next] such that prev.time <= currentTime < next.time
    let prev = null;
    let next = null;

    // Optimization: Store last index on the marker to avoid rescan? 
    // For now, linear scan is fast enough given small stop counts per trip.
    for (let i = 0; i < trip.stops.length - 1; i++) {
        if (currentTime >= trip.stops[i].time && currentTime < trip.stops[i + 1].time) {
            prev = trip.stops[i];
            next = trip.stops[i + 1];
            break;
        }
    }

    if (!prev || !next) return; // Should catch by outer bounds check, but just in case

    // 2. Calculate Progress (t) with Simulation of Wait Time (Dwell)
    // Assume stops[i].time is DEPARTURE time.
    // We want to arrive at next station slightly early and wait.
    const DWELL_TIME = 25; // 25 seconds hold
    const totalDuration = next.time - prev.time;

    // The "movement" phase ends DWELL_TIME before the next departure
    // Guard: Ensure we always have at least 10s or 50% of the segment for movement
    const dwellForThisStretch = Math.min(DWELL_TIME, totalDuration * 0.5);
    const moveDuration = totalDuration - dwellForThisStretch;

    const elapsed = currentTime - prev.time;
    let t = 0;

    if (elapsed >= moveDuration) {
        t = 1.0; // At Station (next)
    } else if (moveDuration > 0) {
        t = elapsed / moveDuration;
    }

    // 3. Get Coordinates (Cached Geometry or LERP)
    const posA = getStopCoords(schedule, prev.id);
    const posB = getStopCoords(schedule, next.id);
    if (!posA || !posB) return;

    let lat, lon;

    // Check Cache / Initialize Marker State
    let marker = activeMarkers[trip.tripId];
    if (!marker) {
        marker = createTrainMarker(trip, routeInfo);
        activeMarkers[trip.tripId] = marker;
    }

    // Segment ID for caching geometry
    const segmentId = `${prev.id}-${next.id}`;

    // Has segment data cached?
    if (marker.segmentId !== segmentId) {
        // New segment, compute shape
        marker.segmentId = segmentId;
        marker.cachedPath = findPathSegment(posA, posB, shapesByRoute[routeId]);
        marker.cachedLength = marker.cachedPath ? turf.length(marker.cachedPath) : 0;

        // Update popup static info only when segment changes
        updateMarkerPopup(marker, trip, routeInfo, prev, next, schedule, isRealtime, delay);
    }

    if (marker.cachedPath && marker.cachedLength > 0) {
        // Follow Shape
        const dist = t * marker.cachedLength;
        const pt = turf.along(marker.cachedPath, dist);
        [lon, lat] = pt.geometry.coordinates;
    } else {
        // Linear Interpolation (Fallback)
        lat = posA[0] + (posB[0] - posA[0]) * t;
        lon = posA[1] + (posB[1] - posA[1]) * t;
    }

    // Move Marker
    marker.setLatLng([lat, lon]);
}

/**
 * Computes the sliced path between two stops using Turf
 */
function findPathSegment(posA, posB, availableShapes) {
    if (!availableShapes || availableShapes.length === 0) return null;

    try {
        const ptA = turf.point([posA[1], posA[0]]);
        const ptB = turf.point([posB[1], posB[0]]);

        let bestShape = null;
        let minDist = Infinity;

        // Optimization: In a real app we might spatial index shapes. 
        // Here we just scan the route's shapes.
        for (const shape of availableShapes) {
            const snapA = turf.nearestPointOnLine(shape, ptA);
            const snapB = turf.nearestPointOnLine(shape, ptB);

            // Distance from stops to the line
            const d = snapA.properties.dist + snapB.properties.dist;

            // Threshold: < 1.0km total error preferred (Increased from 0.5)
            if (d < 1.0 && d < minDist) {
                minDist = d;
                bestShape = shape;
            }
        }

        if (bestShape) {
            const sliced = turf.lineSlice(ptA, ptB, bestShape);
            // Ensure directionality (should move away from A)
            // measure dist from start of slice to A
            const sliceStart = turf.point(sliced.geometry.coordinates[0]);
            const distStartToA = turf.distance(sliceStart, ptA);
            const distStartToB = turf.distance(sliceStart, ptB);

            if (distStartToA > distStartToB) {
                // It's backwards
                sliced.geometry.coordinates.reverse();
            }
            return sliced;
        }
    } catch (e) {
        // console.warn("Path finding error", e);
    }
    return null;
}

// ------ Helpers ------

function indexShapesByRoute(shapes) {
    const idx = {};
    if (shapes && shapes.features) {
        shapes.features.forEach(f => {
            const rid = f.properties.route_id;
            if (!idx[rid]) idx[rid] = [];
            idx[rid].push(f);
        });
    }
    return idx;
}

function getStopCoords(schedule, stopId) {
    const s = schedule.stops[stopId];
    if (s) return s; // [lat, lon, name]
    return null;
}

function createTrainMarker(trip, routeInfo) {
    const color = routeInfo.color || '#fff';
    // CSS-based Icon
    const icon = L.divIcon({
        className: 'train-icon',
        html: `<div class="train-dot" style="
            background: ${color}; 
            width: 10px; 
            height: 10px; 
            border-radius: 50%; 
            box-shadow: 0 0 4px ${color}; 
            border: 1.5px solid white;"></div>`,
        iconSize: [10, 10]
    });

    const marker = L.marker([0, 0], { icon: icon, pane: 'trainsPane' }).addTo(layers.trains);
    return marker;
}


