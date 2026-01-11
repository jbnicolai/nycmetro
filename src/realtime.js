/**
 * Real-Time Data Manager
 * Handles polling /api/realtime and managing application state.
 */

export const rtState = {
    mode: 'REALTIME', // 'REALTIME' or 'SCHEDULE_FALLBACK'
    lastUpdate: 0,
    trips: new Map(), // Map<tripId, { status: "STOPPED_AT"|"IN_TRANSIT_TO", stopId, time, timestamp }>
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

        if (data.trips && Array.isArray(data.trips)) {
            data.trips.forEach(t => {
                rtState.trips.set(t.tripId, {
                    ...t,
                    timestamp: Date.now()
                });
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
