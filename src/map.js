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

    // Locate Control
    const LocateControl = L.Control.extend({
        options: {
            position: 'topleft'
        },
        onAdd: function (map) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
            const button = L.DomUtil.create('a', 'leaflet-control-locate', container);
            button.href = "#";
            button.title = "Locate Me";
            button.role = "button";
            button.style.width = '30px';
            button.style.height = '30px';
            button.style.display = 'flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.backgroundColor = 'white';
            button.style.cursor = 'pointer';

            // Crosshair Icon (SVG)
            const arrowIcon = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="16"></line>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                </svg>
            `;
            button.innerHTML = arrowIcon;

            let userMarker = null;

            L.DomEvent.on(button, 'click', function (e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);

                button.innerHTML = `
                    <svg class="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                    </svg>
                `;

                map.locate({ setView: true, maxZoom: 16 });
            });

            map.on('locationfound', (e) => {
                // Reset Icon
                button.innerHTML = arrowIcon;

                // Show Blue Dot
                if (userMarker) {
                    userMarker.setLatLng(e.latlng);
                } else {
                    // Inner dot
                    userMarker = L.circleMarker(e.latlng, {
                        radius: 6,
                        fillColor: '#3b82f6', // Blue-500
                        color: '#ffffff',
                        weight: 2,
                        opacity: 1,
                        fillOpacity: 1
                    }).addTo(map);

                    // Outer pulse/halo (separate marker for now)
                    L.circleMarker(e.latlng, {
                        radius: 12,
                        fillColor: '#3b82f6',
                        color: '#3b82f6',
                        weight: 0,
                        fillOpacity: 0.2
                    }).addTo(map);
                }
            });

            map.on('locationerror', (e) => {
                alert("Could not access location: " + e.message);
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="red" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                `;
                setTimeout(() => {
                    button.innerHTML = arrowIcon;
                }, 3000);
            });

            return container;
        }
    });

    map.addControl(new LocateControl());

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
    const turf = window.turf; // Local reference

    if (turf) {
        shapes.features.forEach(f => {
            let candidate = f;
            try {
                const color = f.properties.color;
                const offset = COLOR_OFFSETS[color] || 0;

                if (Math.abs(offset) > 0) {
                    // Try Turf offset
                    try {
                        const offsetLine = turf.lineOffset(f, offset, { units: 'kilometers' });
                        if (offsetLine && validateCoords(offsetLine.geometry.coordinates)) {
                            // Copy properties and use this line
                            offsetLine.properties = f.properties;
                            candidate = offsetLine;
                        }
                    } catch (turfErr) {
                        // Turf failed (geometry errors?), fall back to original
                    }
                }
            } catch (err) {
                console.warn("Offset calculation failed", err);
            }

            // Safety Check
            if (validateCoords(candidate.geometry.coordinates)) {
                offsetFeatures.push(candidate);
            }
        });
    } else {
        // Fallback if Turf missing
        console.warn("Turf.js not active. Rendering raw shapes.");
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
