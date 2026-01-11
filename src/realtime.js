/**
 * Real-Time Data Manager
 * Handles polling /api/realtime and managing application state.
 */

export const rtState = {
    mode: 'REALTIME', // 'REALTIME' or 'SCHEDULE_FALLBACK'
    lastUpdate: 0,
    trips: new Map(), // Map<tripId, { status: "STOPPED_AT"|"IN_TRANSIT_TO", stopId, time, timestamp }>
    fuzzyTrips: new Map(), // Map<Time_Route_Dir, TripObject>
    tripGroups: new Map(), // Map<Route_Dir, Array<{startTime, tripData}>>
    hasError: false
};

const INTERVAL_MS = 30000;
let pollTimeout;

export async function initRealtime() {
    console.log("[Realtime] Initializing...");
    await fetchRealtimeData();
    scheduleNextPoll();
}

function scheduleNextPoll() {
    if (pollTimeout) clearTimeout(pollTimeout);
    pollTimeout = setTimeout(async () => {
        await fetchRealtimeData();
        scheduleNextPoll();
    }, INTERVAL_MS);
}

async function fetchRealtimeData() {
    try {
        const res = await fetch('/api/realtime');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        // ... (rest of logic)

        // Update State
        rtState.lastUpdate = Date.now();
        rtState.hasError = false;
        rtState.mode = 'REALTIME';

        // Process Trips
        // We replace the map or merge? Replacing is cleaner for now to remove stale trips.
        // But we might want to keep some history if needed.
        // Let's clear and rebuild for simplicity of "current snapshot"
        rtState.trips.clear();
        rtState.fuzzyTrips.clear();
        rtState.tripGroups.clear();

        if (data.trips && Array.isArray(data.trips)) {
            data.trips.forEach(t => {
                // Strict Match
                const tripData = { ...t, timestamp: Date.now() };
                rtState.trips.set(t.tripId, tripData);

                // Fuzzy Match & Grouping
                // tripId expected format: [TIME]_[ROUTE]..[DIR][VARIANT]
                if (t.tripId && t.tripId.includes('..')) {
                    const [left, right] = t.tripId.split('..');
                    const dir = right.charAt(0);

                    // Legacy key for exact time match
                    rtState.fuzzyTrips.set(`${left}_${dir}`, tripData);

                    // Robust Grouping
                    const timeStr = left.split('_')[0];
                    if (timeStr.length === 6) {
                        const h = parseInt(timeStr.substring(0, 2));
                        const m = parseInt(timeStr.substring(2, 4));
                        const s = parseInt(timeStr.substring(4, 6));
                        const startTimeSeconds = h * 3600 + m * 60 + s;

                        const routeId = t.routeId;
                        const groupKey = `${routeId}_${dir}`;

                        if (!rtState.tripGroups.has(groupKey)) {
                            rtState.tripGroups.set(groupKey, []);
                        }
                        rtState.tripGroups.get(groupKey).push({
                            startTime: startTimeSeconds,
                            data: tripData
                        });
                    }
                }
            });
        }

        updateUI(true);
        console.log(`[Realtime] Updated. ${rtState.trips.size} active trips.`);

    } catch (e) {
        console.error("[Realtime] Fetch Failed:", e);
        rtState.hasError = true;
        rtState.mode = 'SCHEDULE_FALLBACK';
        updateUI(false);

    }
}

export function getMatchingTrip(tripId, routeId) {
    if (rtState.mode !== 'REALTIME') return null;

    // 1. Strict Match
    if (rtState.trips.has(tripId)) return rtState.trips.get(tripId);

    // 2. Legacy Fuzzy (Split by ..)
    const parts = tripId.split('..');
    if (parts.length >= 2) {
        const [left, right] = parts;
        const dir = right.charAt(0);
        const key = `${left}_${dir}`;
        if (rtState.fuzzyTrips.has(key)) return rtState.fuzzyTrips.get(key);

        // 3. Proximity Matching (Robust NYC logic)
        const timeStr = left.split('_')[0];
        if (timeStr.length === 6) {
            const h = parseInt(timeStr.substring(0, 2));
            const m = parseInt(timeStr.substring(2, 4));
            const s = parseInt(timeStr.substring(4, 6));
            const schedStart = h * 3600 + m * 60 + s;

            const groupKey = `${routeId}_${dir}`;
            const group = rtState.tripGroups.get(groupKey);
            if (group) {
                let best = null;
                let minDiff = 600; // 10 mins (NYC headways are often 8-12m)

                for (const rtTrip of group) {
                    const diff = Math.abs(rtTrip.startTime - schedStart);
                    if (diff < minDiff) {
                        minDiff = diff;
                        best = rtTrip.data;
                    }
                }
                if (best) {
                    return best;
                }
            }
        }
    }
    return null;
}

function updateUI(isHealthy) {
    const banner = document.getElementById('rt-error-banner');
    if (!banner) return; // Should be created in index.html or main.js

    if (isHealthy) {
        banner.style.display = 'none';
        document.body.classList.remove('rt-error');
    } else {
        banner.style.display = 'block';
        banner.textContent = "Live Data Unavailable — Showing Scheduled Times";
        document.body.classList.add('rt-error');
    }
}
