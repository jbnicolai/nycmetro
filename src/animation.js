

import { layers } from './map.js';
import { StatusPanel } from './status-panel.js';
import { formatTime } from './utils.js';

let activeMarkers = {}; // tripId -> Marker
let animationFrameId;

// Helper: Seconds to HH:MM:SS (Removed local, using utils)

export function startTrainAnimation(shapes, routes, schedule, visibilitySet) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    // Clear existing
    layers.trains.clearLayers();
    activeMarkers = {};


    if (!window.turf) {
        console.error("Turf.js not found! Animation disabled.");
        return;
    }

    if (!schedule || !schedule.routes) {
        console.warn("No schedule data available.");
        return;
    }

    StatusPanel.log("Animation Engine Started.");
    console.log("[Schedule] Starting Real-Time Animation...");

    // Index shapes by route_id
    const shapesByRoute = {};
    if (shapes && shapes.features) {
        shapes.features.forEach(f => {
            const rid = f.properties.route_id;
            if (!shapesByRoute[rid]) shapesByRoute[rid] = [];
            shapesByRoute[rid].push(f);
        });
    }

    // Animation Loop
    let lastLog = 0;
    let lastLerpLog = 0;
    let frameCount = 0;
    let lastFpsUpdate = 0;

    function animate() {
        const now = new Date();
        const nowMs = now.getTime();

        // Calculate seconds since midnight (local time)
        const secondsSinceMidnight =
            now.getHours() * 3600 +
            now.getMinutes() * 60 +
            now.getSeconds() +
            now.getMilliseconds() / 1000;

        // Stats Update (Throttled 1s)
        frameCount++;
        if (nowMs - lastFpsUpdate >= 1000) {
            StatusPanel.update("fps", frameCount);
            StatusPanel.update("trains", Object.keys(activeMarkers).length); // Use markers count for active trains
            StatusPanel.update("time", formatTime(secondsSinceMidnight));
            lastFpsUpdate = nowMs;
            frameCount = 0;
        }

        // 1. Identify Valid Trips
        const activeTrips = [];
        const debugRouteIds = Object.keys(schedule.routes);

        debugRouteIds.forEach(routeId => {
            if (visibilitySet && visibilitySet.has(routeId)) return;

            const trips = schedule.routes[routeId];
            const routeInfo = routes[routeId];

            trips.forEach(trip => {
                const stops = trip.stops;
                if (!stops || stops.length < 2) return;

                const startTime = stops[0].time;
                const endTime = stops[stops.length - 1].time;

                if (secondsSinceMidnight >= startTime && secondsSinceMidnight <= endTime) {
                    activeTrips.push({ trip, routeId, routeInfo: routeInfo || { color: '#ffffff', short_name: routeId, long_name: 'Unknown' } });
                }
            });
        });

        if (nowMs - lastLog > 10000) {
            StatusPanel.log(`Heartbeat: ${activeTrips.length} Trains active.`);
            lastLog = nowMs;
        }

        // 2. Update Markers
        const currentTripIds = new Set();

        activeTrips.forEach(({ trip, routeId, routeInfo }) => {
            currentTripIds.add(trip.tripId);

            // Find current segment
            let currentStopIndex = -1;
            for (let i = 0; i < trip.stops.length - 1; i++) {
                if (secondsSinceMidnight >= trip.stops[i].time && secondsSinceMidnight < trip.stops[i + 1].time) {
                    currentStopIndex = i;
                    break;
                }
            }

            if (currentStopIndex === -1) return; // Should not happen given outer check

            const prev = trip.stops[currentStopIndex];
            const next = trip.stops[currentStopIndex + 1];

            // Interpolate progress (0.0 to 1.0)
            const duration = next.time - prev.time;
            const elapsed = secondsSinceMidnight - prev.time;
            const t = Math.max(0, Math.min(1, elapsed / duration)); // Clamp

            // Verify Stop Data
            const posA = schedule.stops[prev.id];
            const posB = schedule.stops[next.id];
            if (!posA || !posB) return;

            // Cache path for this segment if not already
            const segmentId = `${prev.id}-${next.id}`;
            let train = activeMarkers[trip.tripId];
            if (train && train.segmentId !== segmentId) {
                // Segment changed, clear cached path
                train.cachedPath = null;
                train.cachedLength = 0;
                train.segmentId = segmentId;
            } else if (!train) {
                // New train, initialize
                train = { segmentId: segmentId, cachedPath: null, cachedLength: 0 };
            }

            if (!train.cachedPath) {
                try {
                    // Try to find a shape that connects these two stops
                    let bestShape = null;
                    if (shapesByRoute[routeId]) {
                        for (const shape of shapesByRoute[routeId]) {
                            const snapA = window.turf.nearestPointOnLine(shape, window.turf.point([posA[1], posA[0]]));
                            const snapB = window.turf.nearestPointOnLine(shape, window.turf.point([posB[1], posB[0]]));

                            // If both are reasonably close (increase tolerance to 0.5km)
                            if (snapA.properties.dist < 0.5 && snapB.properties.dist < 0.5) {
                                bestShape = shape;
                                break; // Found a good one
                            }
                        }
                    }

                    if (bestShape) {
                        const ptA = window.turf.point([posA[1], posA[0]]);
                        const ptB = window.turf.point([posB[1], posB[0]]);
                        const sliced = window.turf.lineSlice(ptA, ptB, bestShape);

                        // Fix Direction: Ensure sliced line starts at A and ends at B
                        const startDist = window.turf.distance(ptA, window.turf.point(sliced.geometry.coordinates[0]));
                        const endDist = window.turf.distance(ptA, window.turf.point(sliced.geometry.coordinates[sliced.geometry.coordinates.length - 1]));

                        if (endDist < startDist) {
                            // The line is backwards relative to our direction of travel
                            sliced.geometry.coordinates.reverse();
                        }

                        // Simplify to remove micro-jitter/stair-stepping
                        // Wrap in try-catch because turf.simplify can crash on very short/degenerate lines
                        try {
                            // Only simplify if we have enough points to matter
                            if (sliced.geometry.coordinates.length > 2) {
                                const simpleSliced = window.turf.simplify(sliced, { tolerance: 0.00005, highQuality: false });
                                train.cachedPath = simpleSliced;
                                train.cachedLength = window.turf.length(simpleSliced);
                            } else {
                                train.cachedPath = sliced;
                                train.cachedLength = window.turf.length(sliced);
                            }
                        } catch (err) {
                            console.warn("Simplification failed, using original slice", err);
                            train.cachedPath = sliced;
                            train.cachedLength = window.turf.length(sliced);
                        }
                    }
                } catch (e) {
                    console.warn("Slice failed", e);
                }
            }

            // CALCULATE POSITION
            let lat, lon;
            const useCached = (train.cachedPath && train.cachedLength > 0);

            if (useCached) {
                // High Quality: Follow the track
                const distAlong = t * train.cachedLength;
                const point = window.turf.along(train.cachedPath, distAlong);
                lon = point.geometry.coordinates[0];
                lat = point.geometry.coordinates[1];
            } else {
                // Fallback: LERP (Straight Line)
                if (now.getTime() - lastLerpLog > 10000) { // Rate limit LERP fallback logs
                    // console.log("Fallback to LERP for", trip.tripId, segmentId);
                    lastLerpLog = now.getTime();
                }
                lon = posA[1] + (posB[1] - posA[1]) * t;
                lat = posA[0] + (posB[0] - posA[0]) * t;
            }

            // Helper to get name (Moved from inner scope)
            const getName = (id) => {
                const s = schedule.stops[id];
                return s ? s[2] : id;
            };



            const latLng = [lat, lon];
            let marker = activeMarkers[trip.tripId];

            if (marker) {
                marker.setLatLng(latLng);
            } else {
                const color = routeInfo.color || '#fff';
                const icon = L.divIcon({
                    className: 'train-icon',
                    html: `<div style="background: ${color}; width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 6px ${color}; border: 1px solid white;"></div>`,
                    iconSize: [12, 12]
                });

                marker = L.marker(latLng, { icon: icon, pane: 'trainsPane' }).addTo(layers.trains);
                activeMarkers[trip.tripId] = marker;

                marker.bindPopup(function (layer) {
                    const d = layer.stopData; // Dynamic data attached to marker
                    if (!d) return "Loading...";
                    return `
                    <div class="train-popup" style="min-width: 200px; font-family: 'Inter', sans-serif;">
                        <div style="border-bottom: 2px solid ${color}; padding-bottom: 5px; margin-bottom: 5px;">
                            <strong style="color:${color}; font-size:1.2em;">${routeInfo.short_name} Train</strong>
                            <div style="font-size:0.8em; color:#888;">To ${getName(trip.stops[trip.stops.length - 1].id)}</div>
                        </div>
                        <div style="display:grid; grid-template-columns: 20px 1fr auto; gap:5px; align-items:center; font-size:0.9em;">
                            <span style="color:#888;">⬇️</span> 
                            <span>${getName(d.next.id)}</span>
                            <span style="color:#aaa; font-size:0.85em; font-family:monospace;">${formatTime(d.next.time)}</span>

                            <span style="color:#888; font-size:0.8em;">⬆️</span> 
                            <span style="color:#666; font-size:0.9em;">${getName(d.prev.id)}</span>
                            <span style="color:#aaa; font-size:0.85em; font-family:monospace;">${formatTime(d.prev.time)}</span>
                        </div>
                    </div>`;
                });
            }

            // Always update data for the popup to use
            marker.stopData = { prev, next };
        });

        // 3. Remove Old Markers
        Object.keys(activeMarkers).forEach(tid => {
            if (!currentTripIds.has(tid)) {
                layers.trains.removeLayer(activeMarkers[tid]);
                delete activeMarkers[tid];
            }
        });

        animationFrameId = requestAnimationFrame(animate);
    }

    console.log("[Schedule] Starting Real-Time Animation...");
    animate();
}
