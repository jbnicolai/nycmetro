import { layers } from './map.js';
import { StatusPanel } from './status-panel.js';
import { formatTime, getDelayInSeconds, getContrastColor, unixToSecondsSinceMidnight, yieldToMain, normId } from './utils.js';
import { rtState, getMatchingTrip, registerMatch } from './realtime.js';
import { renderRouteBadge, renderStatusBadge, renderTimelineRow, renderTrainFooter } from './ui.js';


// Remove local getContrastColor helper at bottom of file if exists (it does)

// Update updateMarkerPopup
function updateMarkerPopup(marker, trip, routeInfo, prev, next, schedule, isRealtime, delay) {
    const getName = (id) => {
        const s = schedule.stops[id];
        return s ? s[2] : id;
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

    const startIdx = Math.max(0, nextIndex - 3);
    const endIdx = Math.min(trip.stops.length, nextIndex + 5);
    const stopSubset = trip.stops.slice(startIdx, endIdx);

    const rowsHtml = stopSubset.map((stop, i) => {
        const absoluteIndex = startIdx + i;
        const isPast = absoluteIndex < nextIndex;
        const isNext = absoluteIndex === nextIndex;
        const stopName = getName(stop.id);

        return renderTimelineRow({ ...stop, name: stopName }, isNext, isPast, routeInfo.color || '#333', delay);
    }).join('');

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
export async function startTrainAnimation(shapes, routes, schedule, visibilitySet) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    // Clear existing
    layers.trains.clearLayers();
    activeMarkers = {};

    // Expose Global Helper
    window.flyToTrain = (tripId) => {
        // Try direct lookup
        let marker = activeMarkers[tripId];

        // If not found, it might be a mapping issue (RT vs Scheduled ID)
        if (!marker) {
            // Scan for marker that has this ID as its rtId or scheduled ID
            for (const m of Object.values(activeMarkers)) {
                if (m.tripId === tripId || m.rtId === tripId) {
                    marker = m;
                    break;
                }
            }
        }

        if (marker) {
            const ll = marker.getLatLng();
            const map = marker._map;
            if (map) {
                map.flyTo(ll, 16, { animate: true, duration: 1.0 }); // Zoom in closer
                // Slight delay to allow flyTo to start
                setTimeout(() => marker.openPopup(), 400);
            }
        } else {
            console.warn("Train not found or not currently active:", tripId);
            StatusPanel.log(`Train ${tripId} not active.`);
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

    StatusPanel.log("Loading Animation Layers...");
    console.log("[Schedule] Starting Real-Time Animation...");

    let currentTrips = [];
    let lastScan = Date.now();
    let lastFpsUpdate = Date.now();
    let frameCount = 0;

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

        const stats = {};
        for (const routeIdRaw of routeKeys) {
            if (++yieldCounter % 10 === 0) await yieldToMain();

            const routeId = normId(routeIdRaw);
            if (visibilitySet && visibilitySet.has(routeId)) return;
            const routeInfo = routes[routeIdRaw] || routes[routeId] || { color: '#ffffff', short_name: routeId };

            const isRtRoute = useRealtime && rtState.rtRouteIds.has(routeId);
            stats[routeId] = { rt: isRtRoute, liveCount: 0, schedCount: 0, skipped: 0, skp_stops: 0, skp_time: 0 };

            let liveTripsFound = 0;
            if (isRtRoute) {
                // Use Live Trips
                rtState.trips.forEach((rtTrip, tripId) => {
                    const tripRouteId = normId(rtTrip.routeId);
                    if (tripRouteId !== routeId) return;

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
                        return;
                    }

                    const endTime = syntheticStops[syntheticStops.length - 1].time;
                    if (secondsSinceMidnight < syntheticStops[0].time - 600 || secondsSinceMidnight > endTime + 300) {
                        stats[routeId].skp_time++;
                        stats[routeId].skipped++;
                        return;
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
                });
            }

            // OPPORTUNISTIC FALLBACK:
            // If the route has NO live data, OR if the live feed produced 0 drawable trains,
            // we fall back to scheduled data so the map isn't empty.
            if (!isRtRoute || liveTripsFound === 0) {
                const schedTrips = schedule.routes[routeIdRaw] || schedule.routes[routeId] || [];
                schedTrips.forEach(trip => {
                    const stops = trip.stops;
                    if (!stops || stops.length < 2) return;
                    const startTime = stops[0].time;
                    const endTime = stops[stops.length - 1].time;

                    if (secondsSinceMidnight < startTime - 600 || secondsSinceMidnight > endTime + 300) return;

                    stats[routeId].schedCount++;
                    activeList.push({
                        trip,
                        routeId,
                        routeInfo,
                        isRealtime: false,
                        source: 'scheduled',
                        delay: 0
                    });
                });
            }
        }

        return activeList;
    }

    async function animate() {
        const now = new Date();
        const nowMs = now.getTime();
        frameCount++;

        const secondsSinceMidnight = unixToSecondsSinceMidnight(nowMs / 1000) + (now.getMilliseconds() / 1000);

        // 1. Heavy Scan (1s)
        if (nowMs - lastScan > 1000) {
            performance.mark('scan-start');
            currentTrips = await scanActiveTrips(secondsSinceMidnight);
            lastScan = nowMs;
            performance.mark('scan-end');
            performance.measure('scan-duration', 'scan-start', 'scan-end');

            const activeIds = new Set(currentTrips.map(t => t.trip.tripId));

            // Marker Adopting Logic
            // If a trip changed ID (e.g. Live -> Sched) but represents the same physical train,
            // we should pass the marker along. For now, we'll use rtId mapping.

            for (const tripId in activeMarkers) {
                if (!activeIds.has(tripId)) {
                    // Check if this marker's RT ID or Scheduled ID is in the new active list
                    const marker = activeMarkers[tripId];
                    const stillActive = currentTrips.find(t => t.trip.tripId === marker.rtId || t.trip.tripId === marker.schedId);

                    if (stillActive) {
                        // Adopt me!
                        activeMarkers[stillActive.trip.tripId] = marker;
                        // But don't delete yet
                    } else {
                        layers.trains.removeLayer(marker);
                    }
                    delete activeMarkers[tripId];
                }
            }
        }

        // 2. Fast Update (60fps)
        currentTrips.forEach(c => {
            updateTrainPosition(c.trip, c.routeId, c.routeInfo, secondsSinceMidnight, shapesByRoute, schedule, c.isRealtime, c.delay, c.rtId);
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
function updateTrainPosition(trip, routeId, routeInfo, secondsSinceMidnight, shapesByRoute, schedule, isRealtime, targetDelay, rtId) {
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

    // Segment ID for caching geometry
    const segmentId = `${prev.id}-${next.id}`;

    // Has segment data cached?
    if (marker.segmentId !== segmentId) {
        // New segment, compute shape
        marker.segmentId = segmentId;
        marker.cachedPath = findPathSegment(posA, posB, shapesByRoute[routeId]);
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

function getStopCoords(schedule, stopId) {
    const s = schedule.stops[stopId];
    if (s) return s; // [lat, lon, name]
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


