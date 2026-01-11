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
        zoomControl: false,
        preferCanvas: true
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

                map.locate({ setView: false, enableHighAccuracy: true });
            });

            map.on('locationfound', (e) => {
                // Smooth Fly
                map.flyTo(e.latlng, 14, {
                    animate: true,
                    duration: 1.5
                });
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

export async function renderSubwayLines(map, shapes, routes) {
    if (!shapes || !routes) {
        console.error("[Map] Aborting render: Missing shapes or routes.");
        return;
    }

    // Clear existing
    Object.values(layers.routeLayers).forEach(l => layers.routes.removeLayer(l));
    layers.routeLayers = {};

    const turf = window.turf;
    const offsetFeatures = [];

    // 1. Process Offsets & Validate (Bulk)
    console.time("ProcessLines");
    for (let i = 0; i < shapes.features.length; i++) {
        const f = shapes.features[i];
        let candidate = f;
        const color = f.properties.color;
        const offset = COLOR_OFFSETS[color] || 0;

        if (turf && Math.abs(offset) > 0) {
            try {
                const offsetLine = turf.lineOffset(f, offset, { units: 'kilometers' });
                if (offsetLine && validateCoords(offsetLine.geometry.coordinates)) {
                    offsetLine.properties = f.properties;
                    candidate = offsetLine;
                }
            } catch (e) { /* Fallback */ }
        }

        if (validateCoords(candidate.geometry.coordinates)) {
            offsetFeatures.push(candidate);
        }

        // Yield to UI every 100 features to prevent long freeze on mobile
        if (i % 100 === 0) await new Promise(r => requestAnimationFrame(r));
    }
    console.timeEnd("ProcessLines");

    // 2. Render to Map
    console.log(`[Map] Rendering ${offsetFeatures.length} features.`);

    // Group segments by route for single-layer efficiency if possible
    // But we use routeLayers for individual toggling.
    const segmentsByRoute = {};
    offsetFeatures.forEach(f => {
        const rid = f.properties.route_id;
        if (!segmentsByRoute[rid]) segmentsByRoute[rid] = [];
        segmentsByRoute[rid].push(f);
    });

    for (const [rid, segments] of Object.entries(segmentsByRoute)) {
        const color = routes[rid] ? routes[rid].color : '#666';
        const routeGroup = L.layerGroup();

        segments.forEach(f => {
            // Leaflet Polyline uses [lat, lon], GeoJSON uses [lon, lat]
            // Turf output is GeoJSON [lon, lat]. L.Polyline.fromGeoJSON or manual flip.
            // L.polyline helper:
            const latlngs = f.geometry.coordinates.map(c => [c[1], c[0]]);

            const poly = L.polyline(latlngs, {
                color: color,
                weight: 3,
                opacity: 0.8,
                smoothFactor: 1.5, // Optimization for high zoom
                lineCap: 'round',
                lineJoin: 'round',
                className: `subway-line-${rid}`
            });

            poly.bindPopup(`Line ${rid}`);
            poly.addTo(routeGroup);
        });

        layers.routeLayers[rid] = routeGroup;
        routeGroup.addTo(layers.routes);

        // Yield every few routes
        await new Promise(r => requestAnimationFrame(r));
    }

    if (!map.hasLayer(layers.routes)) {
        layers.routes.addTo(map);
    }

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
