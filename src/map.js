// State
let map;
export const layers = {
    neighborhoods: L.layerGroup(),
    routes: L.layerGroup(),
    stations: L.layerGroup(),
    trains: L.layerGroup(),
    routeLayers: {} // Store references to individual route layers
};

export const visibilityFilter = new Set(); // Renamed from hiddenRoutes to force cache update

export function initMap() {
    const map = L.map('map', {
        center: [40.730610, -73.935242],
        zoom: 12, // Starting zoom
        minZoom: 11,
        maxZoom: 18,
        zoomControl: false // We'll add it top-right if needed, or stick to default top-left
    });

    // Dark Map Style (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    L.control.zoom({ position: 'topleft' }).addTo(map);

    // Add Layers
    layers.neighborhoods.addTo(map);
    layers.routes.addTo(map);
    layers.stations.addTo(map);
    layers.trains.addTo(map); // Make sure trains are on top

    // Create a custom pane for trains to ensure they are always above lines
    map.createPane('trainsPane');
    map.getPane('trainsPane').style.zIndex = 650; // Above overlayPane (400) and markerPane (600)

    return map;
}

const COLOR_OFFSETS = {
    // Colors of overlapping trunk lines
    '#0062CF': -0.04, // Blue (A,C,E)
    '#EB6800': 0.04,  // Orange (B,D,F,M)
    '#EE352E': -0.02, // Red (1,2,3)
    '#00933C': 0.02,  // Green (4,5,6)
    '#FCCC0A': 0.01   // Yellow (N,Q,R,W)
};

export function renderSubwayLines(map, shapes, routes) {
    console.log("[Map] renderSubwayLines called with:", {
        shapesType: shapes ? shapes.type : 'undefined',
        features: shapes ? shapes.features?.length : 0,
        routesCount: routes ? Object.keys(routes).length : 0
    });

    if (!shapes || !routes) {
        console.error("[Map] Aborting render: Missing shapes or routes.");
        return;
    }

    // Clear existing
    Object.values(layers.routeLayers).forEach(l => layers.routes.removeLayer(l));
    layers.routeLayers = {};

    // 1. Generate Visual Offsets
    const offsetFeatures = [];
    if (window.turf) {
        shapes.features.forEach(f => {
            let candidate = f;
            try {
                const color = f.properties.color;
                const offset = COLOR_OFFSETS[color] || 0;

                if (Math.abs(offset) > 0) {
                    let offsetLine;
                    try {
                        offsetLine = window.turf.lineOffset(f, offset, { units: 'kilometers' });
                    } catch (turfErr) {
                        // Turf failed, ignore
                    }

                    // Copy properties
                    if (offsetLine) {
                        offsetLine.properties = f.properties;
                        if (validateCoords(offsetLine.geometry.coordinates)) {
                            candidate = offsetLine;
                        } else {
                            // Debug logging for the first few failures
                            if (Math.random() < 0.05) {
                                console.warn(`[Offset Failed] Invalid Output for ${f.properties.route_id}:`,
                                    JSON.stringify(offsetLine.geometry.coordinates).slice(0, 100));
                            }
                            // Fallback: Manual Jitter
                            // If turf failed, we just shift lat/lon slightly based on index
                            // This is a naive "poor man's offset"
                            candidate = JSON.parse(JSON.stringify(f));
                            const jitter = offset * 0.005; // approx conversion km to deg
                            candidate.geometry.coordinates = candidate.geometry.coordinates.map(coord => {
                                return [coord[0] + jitter, coord[1] + jitter];
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn("Offset calculation failed", err);
            }

            // FINAL GATEKEEPER
            if (validateCoords(candidate.geometry.coordinates)) {
                offsetFeatures.push(candidate);
            } else {
                console.error(`[CRITICAL] Dropping corrupt feature: Route ${f.properties.route_id}`);
            }
        });
    } else {
        // No turf? Check originals
        shapes.features.forEach(f => {
            if (validateCoords(f.geometry.coordinates)) {
                offsetFeatures.push(f);
            }
        });
    }

    // 2. Render Individually
    console.log(`[Map] Rendering ${offsetFeatures.length} features.`);
    let errorCount = 0;

    // Sort features to ensure consistent layering (e.g. by color or random)
    // This helps slightly with z-fighting if no offsets
    offsetFeatures.sort((a, b) => a.properties.color.localeCompare(b.properties.color));

    offsetFeatures.forEach(feature => {
        try {
            const rid = feature.properties.route_id;
            const color = routes[rid] ? routes[rid].color : '#666';

            // "Creative" Rendering: 
            // 1. Varied widths based on offset direction to create "border" effect if overlapping
            // 2. Use map panes if we were really fancy, but simple path options work

            const lineLayer = L.geoJSON(feature, {
                style: {
                    color: color,
                    weight: 3,
                    opacity: 0.8,
                    lineCap: 'round',
                    lineJoin: 'round',
                    className: `subway-line-${rid}`
                },
                onEachFeature: (feature, layer) => {
                    layer.bindPopup(`Line ${feature.properties.route_id}`);
                }
            });

            if (!layers.routeLayers[rid]) {
                layers.routeLayers[rid] = L.layerGroup();
            }
            lineLayer.addTo(layers.routeLayers[rid]);
        } catch (err) {
            errorCount++;
            console.warn("Failed to render feature:", feature.properties.route_id, err);
        }
    });

    if (errorCount > 0) {
        console.error(`Skipped ${errorCount} corrupted line segments.`);
    }

    // Finally, add all route groups to the main map layer
    const count = Object.keys(layers.routeLayers).length;
    Object.values(layers.routeLayers).forEach(layer => layer.addTo(layers.routes));

    // SAFETY: Ensure main layer is on map
    if (!map.hasLayer(layers.routes)) {
        layers.routes.addTo(map);
        console.log("[Map] Re-added main routes layer to map.");
    }

    console.log(`[Map] Rendered ${count} route layers to the map.`);

    // RETURN the modified shapes so animation can snap to them
    return {
        type: 'FeatureCollection',
        features: offsetFeatures
    };
}

export function toggleRouteLayer(routeId, show) {
    // Update Visibility Set
    if (show) {
        visibilityFilter.delete(routeId);
    } else {
        visibilityFilter.add(routeId);
    }

    // Update Map Layers
    if (layers.routeLayers[routeId]) {
        show ? layers.routeLayers[routeId].addTo(layers.routes) : layers.routes.removeLayer(layers.routeLayers[routeId]);
    }
}

function validateCoords(coords) {
    if (!Array.isArray(coords)) return false;
    // Base case: [x, y]
    if (coords.length >= 2 && typeof coords[0] === 'number') {
        return !isNaN(coords[0]) && !isNaN(coords[1]);
    }
    // Recursive case: Array of arrays
    return coords.every(validateCoords);
}
