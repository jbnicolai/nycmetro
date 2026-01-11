
import { layers } from './map.js';
import { StatusPanel } from './status-panel.js';
import { formatTime } from './utils.js';
import { rtState } from './realtime.js';

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
            activeTripIds.forEach(id => {
                if (rtState.trips.has(id)) rtCount++;
            });

            StatusPanel.update("trains", `<span style="color:#fff">${total}</span> <span style="font-size:0.8em; color:#aaa;">(${rtCount} live)</span>`);
            StatusPanel.update("time", formatTime(secondsSinceMidnight));
            lastFpsUpdate = nowMs;
            frameCount = 0;
        }

        // 1. Identify Valid Trips & Update Positions
        const nextActiveTripIds = new Set();

        // Check RT Mode
        const useRealtime = rtState.mode === 'REALTIME';

        // Iterate all routes
        const routeIds = Object.keys(schedule.routes);
        for (const routeId of routeIds) {
            // Check visibility
            if (visibilitySet && visibilitySet.has(routeId)) continue;

            const trips = schedule.routes[routeId];
            const routeInfo = routes[routeId] || { color: '#ffffff', short_name: routeId };

            // Optimization: Maybe binary search trips in future? For now, simple loop.
            for (const trip of trips) {
                // ... (lines 102-145 omitted for brevity, keeping same logic) ...
                // Optimization: Trip bounds check
                const stops = trip.stops;
                if (!stops || stops.length < 2) continue;

                // --- Realtime Logic ---
                let effectiveTime = secondsSinceMidnight;
                let isRealtime = false;

                if (useRealtime && rtState.trips.has(trip.tripId)) {
                    const rt = rtState.trips.get(trip.tripId);
                    const scheduledStop = trip.stops.find(s => s.id === rt.stopId);
                    if (scheduledStop && rt.time) {
                        const delay = rt.time - scheduledStop.time;
                        effectiveTime -= delay;
                        isRealtime = true;
                    }
                }

                if (effectiveTime < stops[0].time || effectiveTime > stops[stops.length - 1].time) {
                    continue;
                }

                // It is active!
                nextActiveTripIds.add(trip.tripId);
                updateTrainPosition(trip, routeId, routeInfo, effectiveTime, shapesByRoute, schedule, isRealtime, (secondsSinceMidnight - effectiveTime));
            }
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

            // Threshold: < 0.2km total error preferred
            if (d < 0.5 && d < minDist) {
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

function updateMarkerPopup(marker, trip, routeInfo, prev, next, schedule, isRealtime, delay) {
    const getName = (id) => {
        const s = schedule.stops[id];
        return s ? s[2] : id;
    };

    const color = routeInfo.color || '#333';
    const destName = getName(trip.stops[trip.stops.length - 1].id);

    // Time calculations
    const predictedNext = next.time + (delay || 0);
    const predictedPrev = prev.time + (delay || 0);

    let rtStatus = "";
    if (isRealtime) {
        const delayMin = Math.round((delay || 0) / 60);
        let delayText = "";
        let delayColor = "#10b981"; // green

        if (delayMin > 1) {
            delayText = `(+${delayMin}m)`;
            delayColor = "#ef4444"; // red
        } else if (delayMin < -1) {
            delayText = `(${delayMin}m)`;
            delayColor = "#10b981";
        } else {
            delayText = ""; // On time, just show Live
        }

        rtStatus = `
            <div style="display:flex; align-items:center; gap:4px;">
                <span style="background:${delayColor}; color:white; padding:2px 6px; border-radius:4px; font-size:0.7em; font-weight:bold; display:flex; align-items:center; gap:2px;">
                    <span style="animation: pulse 2s infinite;">📶</span> Live
                </span>
                <span style="color:${delayColor}; font-size:0.8em; font-weight:bold;">${delayText}</span>
            </div>`;
    }

    // We only create the popup content once per segment change to avoid string thrashing every frame
    const content = `
    <div class="train-popup" style="min-width: 220px; font-family: 'Inter', sans-serif;">
        <div style="border-bottom: 2px solid ${color}; padding-bottom: 8px; margin-bottom: 8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 2px;">
                <strong style="color:${color}; font-size:1.2em;">${routeInfo.short_name} Train</strong>
                ${rtStatus}
            </div>
            <div style="font-size:0.85em; color:#94a3b8;">To ${destName}</div>
        </div>
        <div style="display:grid; grid-template-columns: 20px 1fr auto; gap:6px; align-items:center; font-size:0.95em;">
            <span style="color:#cbd5e1;">⬇️</span> 
            <span style="color:#f1f5f9;">${getName(next.id)}</span>
            <span style="color:#fff; font-weight:bold; font-size:1.0em; font-family:monospace;">${formatTime(predictedNext)}</span>

            <span style="color:#64748b; font-size:0.8em;">⬆️</span> 
            <span style="color:#64748b; font-size:0.9em;">${getName(prev.id)}</span>
            <span style="color:#94a3b8; font-size:0.85em; font-family:monospace;">${formatTime(predictedPrev)}</span>
        </div>
    </div>`;

    marker.bindPopup(content);
}
