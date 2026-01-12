import { layers, highlightRouteTrack } from './map.js';
import { StatusPanel } from './status-panel.js';
import { formatTime, getDelayInSeconds, getContrastColor, unixToSecondsSinceMidnight, yieldToMain, normId, STATION_ALIASES } from './utils.js';
import { rtState, getMatchingTrip, registerMatch } from './realtime.js';
import { renderRouteBadge, renderStatusBadge, renderTimelineRow, renderTrainFooter } from './ui.js';
import { updateHash } from './history.js';


// Remove local getContrastColor helper at bottom of file if exists (it does)

// Update updateMarkerPopup
function updateMarkerPopup(marker, trip, routeInfo, prev, next, schedule, isRealtime, delay) {
    const getName = (id) => {
        if (!id) return id;

        // Try direct lookup
        let s = schedule.stops[id];
        if (s) return s[2];

        // Try parent ID (strip suffix like N/S)
        if (id.length > 3) {
            const parentId = id.slice(0, -1);
            s = schedule.stops[parentId];
            if (s) return s[2];
        }

        // Fallback to ID (do NOT use STATION_ALIASES for names - 
        // they are for coord lookup only and can cause wrong names)
        return id;
    };

    const destName = getName(trip.stops[trip.stops.length - 1].id);

    // 1. Source Indicator
    let rtStatus = "";
    if (isRealtime) {
        rtStatus = `
            <div class="train-realtime-badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981; border-color: rgba(16, 185, 129, 0.3);">
                <span class="blink-dot" style="background: #10b981;"></span> LIVE DATA
            </div>`;
    } else {
        rtStatus = `
            <div class="train-realtime-badge" style="background: rgba(156, 163, 175, 0.2); color: #9ca3af; border-color: rgba(156, 163, 175, 0.3);">
                SCHEDULED
            </div>`;
    }

    const routeBadgeHtml = renderRouteBadge(routeInfo.short_name, routeInfo);

    // 2. Timeline
    let nextIndex = trip.stops.findIndex(s => s.id === next.id && s.time === next.time);
    if (nextIndex === -1) nextIndex = 0;

    // Check if train is dwelling at the next station
    const currentTime = (Date.now() / 1000) % 86400;
    const adjustedTime = currentTime - (delay || 0);
    const prevTime = prev.time;
    const nextTime = next.time;
    const totalDuration = nextTime - prevTime;
    const DWELL_TIME = 25;
    const dwellForThisStretch = Math.min(DWELL_TIME, totalDuration * 0.5);
    const moveDuration = totalDuration - dwellForThisStretch;
    const elapsed = adjustedTime - prevTime;
    const isDwelling = elapsed >= moveDuration;

    const startIdx = Math.max(0, nextIndex - 3);
    const endIdx = Math.min(trip.stops.length, nextIndex + 5);
    const stopSubset = trip.stops.slice(startIdx, endIdx);

    const rowsHtml = stopSubset.map((stop, i) => {
        const absoluteIndex = startIdx + i;
        // When dwelling at a station, keep that station marked as "next" (current), not "past"
        const isPast = absoluteIndex < (isDwelling ? nextIndex : nextIndex);
        const isNext = absoluteIndex === nextIndex;
        const stopName = getName(stop.id);

        return renderTimelineRow({ ...stop, name: stopName }, isNext, isPast, routeInfo.color || '#333', delay);
    }).join('');

    // Debug: Log if timeline rows are being generated
    if (!rowsHtml || rowsHtml.indexOf('timeline-dot') === -1) {
        console.warn('[updateMarkerPopup] Timeline rows missing dots! tripId:', trip.tripId, 'rowsHtml length:', rowsHtml.length);
    }

    // 3. Footer
    const footerHtml = renderTrainFooter(
        { ...trip.stops[0], name: getName(trip.stops[0].id) },
        { ...trip.stops[trip.stops.length - 1], name: getName(trip.stops[trip.stops.length - 1].id) },
        Math.round((trip.stops[trip.stops.length - 1].time - trip.stops[0].time) / 60)
    );

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
        marker.unbindPopup();
    }

    marker.bindPopup(content, {
        className: 'train-leaflet-popup',
        minWidth: 340,
        maxWidth: 360,
        autoPan: false
    });

    // Store trip reference
    marker.tripData = { trip, routeInfo, schedule };

    // When popup opens, update URL hash
    marker.off('popupopen');
    marker.on('popupopen', () => {
        updateHash('train', trip.tripId, { replace: false });
    });
}

let activeMarkers = {}; // tripId -> Marker
let activeTripIds = new Set(); // tripId set for stats
let animationFrameId;

// Safe Turf Wrapper
const turf = window.turf;

/**
 * Main Entry Point: Start Animation Loop
 */
export async function startTrainAnimation(shapes, routes, schedule, visibilitySet, stopsCoords) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    // Clear existing
    layers.trains.clearLayers();
    activeMarkers = {};

    // Expose Global Helper
    window.flyToTrain = (tripId) => {
        StatusPanel.log(`🔍 Looking for train: ${tripId}`);
        // Try direct lookup
        let marker = activeMarkers[tripId];

        // If not found, it might be a mapping issue (RT vs Scheduled ID)
        if (!marker) {
            // Scan for marker that has this ID as its rtId or scheduled ID
            for (const m of Object.values(activeMarkers)) {
                if (m.tripId === tripId || m.rtId === tripId || m.schedId === tripId) {
                    marker = m;
                    break;
                }
            }
        }

        if (marker) {
            const ll = marker.getLatLng();

            // Bounds Check (NYC rough box)
            if (ll.lat === 0 && ll.lng === 0) {
                console.warn(`Train ${tripId} is at [0,0] (Off Grid). Skipping flyTo.`);
                StatusPanel.log(`Train ${tripId} is awaiting location...`);
                return;
            }
            if (ll.lat < 40.4 || ll.lat > 41.0 || ll.lng < -74.3 || ll.lng > -73.6) {
                console.warn(`Train ${tripId} is out of bounds: ${ll.lat}, ${ll.lng}. Skipping flyTo.`);
                StatusPanel.log(`Train ${tripId} location invalid.`);
                return;
            }

            const map = marker._map;
            if (map) {
                // Highlight the Route Track
                if (marker.routeId) {
                    highlightRouteTrack(marker.routeId);
                }

                map.flyTo(ll, 16, { animate: true, duration: 1.0 }); // Zoom in closer
                // Slight delay to allow flyTo to start
                setTimeout(() => {
                    // Ensure popup content is fresh before opening
                    if (marker.tripData && marker.currentPrev && marker.currentNext) {
                        updateMarkerPopup(
                            marker,
                            marker.tripData.trip,
                            marker.tripData.routeInfo,
                            marker.currentPrev,
                            marker.currentNext,
                            marker.tripData.schedule,
                            marker.isRealtime || false,
                            marker.currentDelay || 0
                        );
                    }
                    marker.openPopup();
                    // Update URL hash for deep linking
                    updateHash('train', tripId, { replace: false });
                }, 400);
            }
        } else {
            console.warn("Train not found or not currently active:", tripId);
            console.log("Active Trip IDs:", Object.keys(activeMarkers));
            StatusPanel.log(`Train ${tripId} not active.`);
        }
    };

    if (!turf) {
        console.error("Turf.js not found! Animation disabled.");
        StatusPanel.log("Error: Turf.js missing. Animation stopped.");
        throw new Error("Turf.js missing");
    }

    if (!schedule || !schedule.routes) {
        console.warn("No schedule data available.");
        throw new Error("No schedule data");
    }

    StatusPanel.log("Loading Animation Layers...");
    console.log("[Schedule] Starting Real-Time Animation...");

    let currentTrips = [];
    let lastScan = Date.now();
    let lastFpsUpdate = Date.now();
    let frameCount = 0;
    let isScanning = false;

    // Index shapes directly for faster lookups
    const shapesByRoute = await indexShapesByRoute(shapes);

    StatusPanel.log("Preparing Active Trips...");
    const routeKeys = (schedule && schedule.routes) ? Object.keys(schedule.routes) : [];

    // Initial scan to populate currentTrips immediately
    const startSecs = unixToSecondsSinceMidnight(Date.now() / 1000);
    currentTrips = await scanActiveTrips(startSecs);

    async function scanActiveTrips(secondsSinceMidnight) {
        const activeList = [];
        const useRealtime = rtState.mode === 'REALTIME';
        let yieldCounter = 0;

        // PRE-GROUP RT TRIPS BY ROUTE to avoid O(N*M) loop
        const rtTripsByRoute = {};
        if (useRealtime) {
            rtState.trips.forEach((rtTrip, tripId) => {
                const rid = normId(rtTrip.routeId);
                if (!rtTripsByRoute[rid]) rtTripsByRoute[rid] = [];
                rtTripsByRoute[rid].push({ trip: rtTrip, id: tripId });
            });
        }

        const stats = {};

        // Process one route at a time
        for (const routeIdRaw of routeKeys) {
            if (++yieldCounter % 5 === 0) await yieldToMain(); // Yield more often

            const routeId = normId(routeIdRaw);
            if (visibilitySet && visibilitySet.has(routeId)) continue;
            const routeInfo = routes[routeIdRaw] || routes[routeId] || { color: '#ffffff', short_name: routeId };

            const isRtRoute = useRealtime && rtState.rtRouteIds.has(routeId);
            stats[routeId] = { rt: isRtRoute, liveCount: 0, schedCount: 0, skipped: 0, skp_stops: 0, skp_time: 0 };

            const liveTripIds = new Set();
            const liveTimesByDir = { N: [], S: [] };
            let liveTripsFound = 0;
            if (isRtRoute && rtTripsByRoute[routeId]) {
                // Use Pre-grouped Live Trips
                for (const item of rtTripsByRoute[routeId]) {
                    const rtTrip = item.trip;
                    const tripId = item.id;
                    liveTripIds.add(tripId);
                    // Also track fuzzy matches if possible?
                    // For now, rely on strict ID match or mapped SchedID.

                    const syntheticStops = [];
                    let lastTime = -1;

                    if (rtTrip.stopTimeUpdate) {
                        for (const stu of rtTrip.stopTimeUpdate) {
                            const rawT = stu.arrival?.time || stu.departure?.time;
                            if (!rawT) continue;
                            let t = unixToSecondsSinceMidnight(rawT);
                            if (lastTime !== -1 && t < lastTime) t += 86400;
                            syntheticStops.push({ id: stu.stopId, time: t });
                            lastTime = t;
                        }
                    }

                    if (syntheticStops.length < 2) {
                        stats[routeId].skp_stops++;
                        stats[routeId].skipped++;
                        continue;
                    }

                    const endTime = syntheticStops[syntheticStops.length - 1].time;
                    // Extended window to 900s (15m) to ensure 'Departed' trains stay clickable
                    if (secondsSinceMidnight < syntheticStops[0].time - 600 || secondsSinceMidnight > endTime + 900) {
                        stats[routeId].skp_time++;
                        stats[routeId].skipped++;
                        continue;
                    }

                    // Index for Fuzzy Dedup
                    const firstStop = syntheticStops[0];
                    const dir = firstStop.id.slice(-1); // 'N' or 'S' usually
                    if (dir === 'N' || dir === 'S') {
                        let originTime = firstStop.time;
                        // Use Trip Start Time from Feed Header if available (Stable Identity)
                        if (rtTrip.startTime) {
                            const [h, m, s] = rtTrip.startTime.split(':').map(Number);
                            originTime = h * 3600 + m * 60 + s;
                        }
                        liveTimesByDir[dir].push(originTime);
                    }

                    stats[routeId].liveCount++;
                    liveTripsFound++;
                    activeList.push({
                        trip: { tripId, stops: syntheticStops, isSynthetic: true },
                        routeId,
                        routeInfo,
                        isRealtime: true,
                        source: 'live',
                        delay: 0
                    });
                }
            }

            // ALWAYS FALLBACK (Backfill):
            // Even if isRtRoute is true, we might miss some trains (e.g. Departed/Finished).
            // Check schedule for any trains that are active/departed but currently missing from Live.
            // CHANGE: User requested STRICT separation. If we have live data for a route, 
            // we assume the live feed is the SOURCE OF TRUTH and do NOT backfill with schedule.
            // This prevents "Ghost Trains" (Scheduled) appearing next to Live trains.
            if (!isRtRoute) {
                const schedTrips = schedule.routes[routeIdRaw] || schedule.routes[routeId] || [];

                // As optimization, only run full backfill if we have gaps or if it's the requested route?
                // No, we need it for all to ensure map consistency.
                // Use classic loop for speed.
                for (let i = 0; i < schedTrips.length; i++) {
                    const trip = schedTrips[i];

                    // DEDUP:
                    // 1. Strict ID Match
                    if (isRtRoute && liveTripIds.has(trip.tripId)) continue;

                    const stops = trip.stops;
                    if (!stops || stops.length < 2) continue;
                    const startTime = stops[0].time;

                    if (isRtRoute) {
                        const stopId = stops[0].stopId;
                        const dir = stopId ? stopId.slice(-1) : null;
                        if (dir === 'N' || dir === 'S') {
                            const times = liveTimesByDir[dir];
                            // If any live train is within 5 minutes (300s) of this scheduled time, assume covered.
                            // (NYC Headways are >5m usually, so collision implies same train)
                            const isCovered = times.some(t => Math.abs(t - startTime) < 300);
                            if (isCovered) continue;
                        }
                    }

                    const endTime = stops[stops.length - 1].time;

                    // Extended window for scheduled too
                    if (secondsSinceMidnight < startTime - 600 || secondsSinceMidnight > endTime + 900) continue;

                    stats[routeId].schedCount++;
                    activeList.push({
                        trip,
                        routeId,
                        routeInfo,
                        isRealtime: false,
                        source: 'scheduled',
                        delay: 0
                    });
                }
            }
        }

        return activeList;
    }

    async function animate() {
        const now = new Date();
        const nowMs = now.getTime();
        frameCount++;

        const secondsSinceMidnight = unixToSecondsSinceMidnight(nowMs / 1000) + (now.getMilliseconds() / 1000);

        // 1. Heavy Scan (Run in background every 1s, don't block frame)
        if (nowMs - lastScan > 1000 && !isScanning) {
            isScanning = true;
            // Don't await! Let it run in background.
            scanActiveTrips(secondsSinceMidnight).then(trips => {
                currentTrips = trips; // Atomic update
                lastScan = Date.now();
                isScanning = false;

                // Marker Adopting Logic (Run here when trips update)
                const activeIds = new Set(trips.map(t => t.trip.tripId));
                for (const tripId in activeMarkers) {
                    if (!activeIds.has(tripId)) {
                        const marker = activeMarkers[tripId];
                        // Check if matched by RT or Sched ID
                        const stillActive = trips.find(t => t.trip.tripId === marker.rtId || t.trip.tripId === marker.schedId);
                        if (stillActive) {
                            activeMarkers[stillActive.trip.tripId] = marker;
                            delete activeMarkers[tripId];
                        } else {
                            // Defer removal slightly to avoid flicker? No, just remove.
                            // ACTUALLY: If clickability is an issue for 'Departed', we keep them?
                            // No, if they are 'Departed' in stations.js, they might be culled here.
                            // But we extended the window to 900s, so they should stick around.
                            layers.trains.removeLayer(marker);
                            delete activeMarkers[tripId];
                        }
                    }
                }
            }).catch(e => {
                console.error("Scan error", e);
                isScanning = false;
            });
        }

        // 2. Fast Update (60fps)
        currentTrips.forEach(c => {
            updateTrainPosition(c.trip, c.routeId, c.routeInfo, secondsSinceMidnight, shapesByRoute, schedule, c.isRealtime, c.delay, c.rtId, stopsCoords);
        });

        if (nowMs - lastFpsUpdate >= 1000) {
            StatusPanel.update("fps", frameCount);
            StatusPanel.update("trains", `<span style="color:#fff">${currentTrips.length}</span> <span style="font-size:0.8em; color:#aaa;">(Active)</span>`);
            StatusPanel.update("time", formatTime(secondsSinceMidnight));
            lastFpsUpdate = nowMs;
            frameCount = 0;
        }

        animationFrameId = requestAnimationFrame(animate);
    }

    // Export debug helper
    window.debugTransit = () => {
        console.log("--- Transit Debug Hook ---");
        console.log("rtState Mode:", rtState.mode);
        console.log("rtState Routes with Live:", Array.from(rtState.rtRouteIds));

        const rtCounts = {};
        rtState.trips.forEach(t => {
            const rid = normId(t.routeId);
            rtCounts[rid] = (rtCounts[rid] || 0) + 1;
        });
        console.log("Trip counts in rtState.trips by Route ID:", rtCounts);

        const activeSummary = currentTrips.reduce((acc, t) => {
            acc[t.routeId] = (acc[t.routeId] || 0) + 1;
            return acc;
        }, {});
        console.log("Final Active Trains on Map by Route ID:", activeSummary);

        console.log("Visibility List (Set):", visibilitySet ? Array.from(visibilitySet) : "None");

        return "Check logs above.";
    };

    animate();
}

/**
 * Updates a single train's position and marker
 */
function updateTrainPosition(trip, routeId, routeInfo, secondsSinceMidnight, shapesByRoute, schedule, isRealtime, targetDelay, rtId, stopsCoords) {
    // 1. Find Current Segment
    let marker = activeMarkers[trip.tripId];
    if (!marker) {
        marker = createTrainMarker(trip, routeInfo, schedule);
        activeMarkers[trip.tripId] = marker;
        marker.animatedDelay = targetDelay;
        marker.tripId = trip.tripId;

        // Identity Tracking
        if (isRealtime) {
            marker.rtId = trip.tripId;
            marker.schedId = (typeof getMatchingTrip === 'function') ? getMatchingTrip(trip.tripId, routeId)?.tripId : null;
        } else {
            marker.schedId = trip.tripId;
            // No easy way to find rtId here, but adopting logic handles it.
        }
    }

    // Smooth Delay Transition (Slower catchup: catch up over ~10s instead of ~2s)
    if (Math.abs(marker.animatedDelay - targetDelay) > 0.1) {
        const step = (targetDelay - marker.animatedDelay) * 0.02;
        marker.animatedDelay += step;
    } else {
        marker.animatedDelay = targetDelay;
    }

    const currentTime = secondsSinceMidnight - marker.animatedDelay;

    // We want the segment [prev, next] such that prev.time <= currentTime < next.time
    let prev = null;
    let next = null;

    // Optimization: Store last index on the marker to avoid rescan? 
    // For now, linear scan is fast enough given small stop counts per trip.

    // CASE 1: Before Start (Waiting at First Station)
    if (currentTime < trip.stops[0].time) {
        const startStop = trip.stops[0];
        const pos = getStopCoords(schedule, startStop.id, stopsCoords);
        if (pos) {
            marker.setLatLng([pos[0], pos[1]]);

            // Store segment info for popup refresh
            marker.currentPrev = startStop;
            marker.currentNext = trip.stops[1];
            marker.isRealtime = isRealtime;
            marker.currentDelay = targetDelay;

            updateMarkerPopup(marker, trip, routeInfo, startStop, trip.stops[1], schedule, isRealtime, targetDelay);
        }
        return;
    }

    // CASE 2: In Transit
    for (let i = 0; i < trip.stops.length - 1; i++) {
        if (currentTime >= trip.stops[i].time && currentTime < trip.stops[i + 1].time) {
            prev = trip.stops[i];
            next = trip.stops[i + 1];
            break;
        }
    }

    // CASE 3: After End (Finished)
    if (!prev || !next) {
        // Likely finished trip or just out of bounds
        const lastStop = trip.stops[trip.stops.length - 1];
        if (currentTime >= lastStop.time) {
            const pos = getStopCoords(schedule, lastStop.id, stopsCoords);
            if (pos) marker.setLatLng([pos[0], pos[1]]);
        }
        return;
    }

    // Store current segment for popup refresh
    marker.currentPrev = prev;
    marker.currentNext = next;
    marker.isRealtime = isRealtime;
    marker.currentDelay = targetDelay;

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
    const posA = getStopCoords(schedule, prev.id, stopsCoords);
    const posB = getStopCoords(schedule, next.id, stopsCoords);
    if (!posA || !posB) return;

    let lat, lon;

    // Segment ID for caching geometry
    const segmentId = `${prev.id}-${next.id}`;

    // Has segment data cached?
    if (marker.segmentId !== segmentId) {
        // New segment, compute shape
        marker.segmentId = segmentId;

        // Try to find shapes for this route, including common variations
        let shapes = shapesByRoute[routeId];

        if (!shapes || shapes.length === 0) {
            // Try common variations and extract route from trip ID
            // E.g., trip "124200_5..S16X002" -> try route "5"
            const tripRouteMatch = trip.tripId.match(/_([A-Z0-9]+)\.\./);
            const tripRoute = tripRouteMatch ? tripRouteMatch[1] : null;

            const variations = [
                routeId,
                `${routeId}_`,
                `${routeId}X`,
                routeId.replace('_', ''),
                routeId.split('_')[0],
                tripRoute // Route extracted from trip ID
            ].filter(Boolean);

            for (const variant of variations) {
                if (shapesByRoute[variant] && shapesByRoute[variant].length > 0) {
                    shapes = shapesByRoute[variant];
                    break;
                }
            }

            if (!shapes || shapes.length === 0) {
                console.warn(`[Animation] No shapes for route ${routeId}, segment ${prev.id} -> ${next.id}`);
            }
        }

        marker.cachedPath = findPathSegment(posA, posB, shapes, routeId, trip.tripId, prev.id, next.id);
        marker.cachedLength = marker.cachedPath ? turf.length(marker.cachedPath) : 0;

        // Update popup static info only when segment changes
        updateMarkerPopup(marker, trip, routeInfo, prev, next, schedule, isRealtime, targetDelay);
    }

    if (marker.cachedPath && marker.cachedLength > 0) {
        // Follow Shape
        const dist = t * marker.cachedLength;
        const pt = turf.along(marker.cachedPath, dist);
        [lon, lat] = pt.geometry.coordinates;
    } else {
        // No valid path - stay at previous station instead of LERP across map
        // This prevents trains from "floating" across water/wrong areas
        lat = posA[0];
        lon = posA[1];
    }

    // Move Marker
    marker.setLatLng([lat, lon]);
}

/**
 * Computes the sliced path between two stops using Turf
 */
function findPathSegment(posA, posB, availableShapes, routeId = '?', tripId = '?', fromStop = '?', toStop = '?') {
    if (!availableShapes || availableShapes.length === 0) {
        return null;
    }

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

        if (!bestShape) {
            console.warn(`[findPathSegment] Route ${routeId}, Trip ${tripId}: No shape within 1km for ${fromStop} -> ${toStop}. Min dist: ${minDist.toFixed(2)}km`);
            return null;
        }

        // Snap points and slice
        const snappedA = turf.nearestPointOnLine(bestShape, ptA);
        const snappedB = turf.nearestPointOnLine(bestShape, ptB);
        const sliced = turf.lineSlice(snappedA, snappedB, bestShape);

        // measure dist from start of slice to A
        const sliceStart = turf.point(sliced.geometry.coordinates[0]);
        const distStartToA = turf.distance(sliceStart, ptA);
        const distStartToB = turf.distance(sliceStart, ptB);

        if (distStartToA > distStartToB) {
            // It's backwards
            sliced.geometry.coordinates.reverse();
        }
        return sliced;
    } catch (e) {
        console.warn('[findPathSegment] Error:', e);
        return null;
    }
}

// ------ Helpers ------

async function indexShapesByRoute(shapes) {
    const idx = {};
    if (shapes && shapes.features) {
        let yieldCounter = 0;
        for (let i = 0; i < shapes.features.length; i++) {
            if (++yieldCounter % 100 === 0) await yieldToMain();

            const f = shapes.features[i];
            const rid = f.properties.route_id;
            if (!idx[rid]) idx[rid] = [];
            idx[rid].push(f);
        }
    }
    return idx;
}

// Local STATION_ALIASES removed (imported from utils.js)

// Local STATION_ALIASES removed (imported from utils.js)

const MANUAL_COORDS = {}; // Deprecated in favor of stopsCoords

function getStopCoords(schedule, stopId, stopsCoords) {
    if (!stopId) return null;

    // 0. Priority: Comprehensive GTFS Stops Map (stopsCoords)
    if (stopsCoords && stopsCoords[stopId]) {
        return stopsCoords[stopId];
    }

    // 1. Direct Lookup in Schedule
    let s = schedule.stops[stopId];
    if (s) return [s[0], s[1]];

    // 1b. Alias Lookup (Important for ID mismatches like R65 -> G19)
    if (STATION_ALIASES[stopId]) {
        const alias = STATION_ALIASES[stopId];
        // Check coords for alias
        if (stopsCoords && stopsCoords[alias]) return stopsCoords[alias];
        s = schedule.stops[alias];
        if (s) return [s[0], s[1]];
    }

    // 2. Suffix Stripping (e.g. "R01N" -> "R01")
    if (stopId.length > 3) {
        // Try looking up parent in stopsCoords
        const parentId = stopId.slice(0, -1);
        if (stopsCoords && stopsCoords[parentId]) {
            return stopsCoords[parentId];
        }

        // Try parent in schedule
        s = schedule.stops[parentId];
        if (s) return [s[0], s[1]];

        // Try parent alias
        if (STATION_ALIASES[parentId]) {
            const alias = STATION_ALIASES[parentId];
            if (stopsCoords && stopsCoords[alias]) return stopsCoords[alias];
            s = schedule.stops[alias];
            if (s) return [s[0], s[1]];
        }
    }

    // DEBUG: Log missing IDs (once per ID to avoid spam)
    /*
    if (!window._missingIds) window._missingIds = new Set();
    if (!window._missingIds.has(stopId)) {
        console.warn(`[getStopCoords] Missing coords for: '${stopId}'`);
        window._missingIds.add(stopId);
    }
    */

    return null;
}

function createTrainMarker(trip, routeInfo, schedule) {
    const color = routeInfo.color || '#fff';
    const routeId = routeInfo.id || '?';

    const getName = (id) => {
        const s = schedule.stops[id];
        return s ? s[2] : id;
    };
    const dest = getName(trip.stops[trip.stops.length - 1].id);

    // CSS-based Icon with large hit area (32px)
    const icon = L.divIcon({
        className: 'train-icon',
        html: `<div style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
                <div class="train-dot" style="
                    background: ${color}; 
                    width: 10px; 
                    height: 10px; 
                    border-radius: 50%; 
                    box-shadow: 0 0 4px ${color}; 
                    border: 1.5px solid white;"></div>
               </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16] // Center it
    });

    const marker = L.marker([0, 0], {
        icon: icon,
        pane: 'trainsPane',
        zIndexOffset: 1000 // Ensure trains are above stations
    }).addTo(layers.trains);

    // Train Hover Label with Badge
    const tooltipHtml = `
        <div class="train-label-content">
            <span class="route-badge" style="background-color: ${color};">${routeId}</span>
            <span class="dest-text">${dest}</span>
        </div>
    `;

    marker.bindTooltip(tooltipHtml, {
        className: 'train-label',
        direction: 'top',
        offset: [0, -15],
        opacity: 1,
        permanent: false,
        sticky: true
    });

    return marker;
}


