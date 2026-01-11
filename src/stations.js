import { parseProperties, formatTime } from './utils.js';

let stationScheduleIndex = null;
let rawSchedule = null;

// Pre-process schedule: { stationId_base: { N: [], S: [] } }
function buildStationScheduleIndex(schedule) {
    if (!schedule || !schedule.routes) return;
    rawSchedule = schedule;
    stationScheduleIndex = {};

    console.log("Building Station Schedule Index...");
    Object.keys(schedule.routes).forEach(routeId => {
        const trips = schedule.routes[routeId];
        trips.forEach(trip => {
            trip.stops.forEach(stop => {
                const baseId = stop.id.substring(0, 3); // e.g., "101N" -> "101"
                const dir = stop.id.slice(-1); // "N" or "S"

                if (!stationScheduleIndex[baseId]) {
                    stationScheduleIndex[baseId] = { N: [], S: [] };
                }

                // Store stop info
                if (stationScheduleIndex[baseId][dir]) {
                    stationScheduleIndex[baseId][dir].push({
                        routeId: routeId,
                        time: stop.time,
                        tripId: trip.tripId
                    });
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

export function renderStations(geoJson, layerGroup, schedule, routes) {
    if (schedule && !stationScheduleIndex) {
        buildStationScheduleIndex(schedule);
    }
    if (routes) {
        routeConfigs = routes;
    }

    L.geoJSON(geoJson, {
        pointToLayer: (feature, latlng) => {
            if (!latlng || isNaN(latlng.lat) || isNaN(latlng.lng)) {
                console.warn("Invalid station coordinates:", feature);
                return null;
            }

            // Try to match station ID if schedule is available
            if (schedule && schedule.stops && !feature.properties.gtfs_stop_id) {
                const matchedId = matchStationId(latlng.lat, latlng.lng, schedule.stops);
                if (matchedId) {
                    feature.properties.gtfs_stop_id = matchedId;
                }
            }

            return L.circleMarker(latlng, { radius: 3, fillColor: '#ffffff', color: '#000', weight: 1, opacity: 1, fillOpacity: 0.8 });
        },
        onEachFeature: (feature, layer) => {
            if (!layer) return; // Skip if null return from pointToLayer
            const { name } = parseProperties(feature);

            layer.bindTooltip(name, { direction: 'top', className: 'subway-label' });
            // Pass the feature which now hopefully has gtfs_stop_id
            layer.on('click', () => showStationPopup(name, layer, feature));
        }
    }).addTo(layerGroup);
}

function showStationPopup(name, layer, feature) {
    // Current Time
    const now = new Date();
    const secondsSinceMidnight =
        now.getHours() * 3600 +
        now.getMinutes() * 60 +
        now.getSeconds();

    let content = `<div style="min-width: 250px;">
        <h3 style="margin-top:0; margin-bottom:10px; border-bottom:1px solid #ddd; padding-bottom:5px;">${name}</h3>`;

    // Try to find schedule content
    let stopId = feature.properties.gtfs_stop_id || feature.properties.stop_id;
    if (stopId && stopId.length > 3) {
        stopId = stopId.substring(0, 3);
    }

    if (stationScheduleIndex && stopId && stationScheduleIndex[stopId]) {
        const data = stationScheduleIndex[stopId];

        const getNextTrains = (list) => {
            return list.filter(t => t.time >= secondsSinceMidnight).slice(0, 3);
        };

        const north = getNextTrains(data.N);
        const south = getNextTrains(data.S);

        const renderRow = (t) => {
            const routeId = t.routeId;
            const color = routeConfigs[routeId] ? routeConfigs[routeId].color : '#666';
            const textColor = getContrastColor(color);

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.9em; margin-bottom:4px;">
                <span style="
                    background-color: ${color}; 
                    color: ${textColor}; 
                    padding: 2px 6px; 
                    border-radius: 4px; 
                    font-weight: bold; 
                    min-width: 24px; 
                    text-align: center;
                    display: inline-block;
                ">${routeId}</span>
                <span style="font-family:monospace; color:#555;">${formatTime(t.time)}</span>
            </div>`;
        };

        content += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
            <div>
                <strong style="font-size:0.75em; text-transform:uppercase; color:#888; display:block; margin-bottom:6px;">Northbound</strong>
                ${north.length ? north.map(renderRow).join('') : '<div style="color:#aaa; font-size:0.8em; font-style:italic;">No trains</div>'}
            </div>
            <div>
                <strong style="font-size:0.75em; text-transform:uppercase; color:#888; display:block; margin-bottom:6px;">Southbound</strong>
                ${south.length ? south.map(renderRow).join('') : '<div style="color:#aaa; font-size:0.8em; font-style:italic;">No trains</div>'}
            </div>
        </div>`;

    } else {
        content += `<div style="color:#666; font-size:0.8em; margin-top:5px;"><em>No schedule data available.</em></div>`;
    }

    content += `</div>`;

    layer.bindPopup(content).openPopup();
}
