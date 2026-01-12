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
    map = L.map('map', {
        center: [40.730610, -73.935242],
        zoom: 12, // Starting zoom
        minZoom: 11,
        maxZoom: 18,
        zoomControl: false,
        preferCanvas: true,
        renderer: L.canvas({ padding: 0.5, tolerance: 10 })
    });

    // Create Custom Panes for Fade Effects
    const panes = ['neighborhoods', 'routes', 'stations', 'trains'];
    panes.forEach((name, i) => {
        const pane = map.createPane(name + 'Pane');
        pane.style.zIndex = 400 + (i * 10);
        pane.classList.add('layer-hidden');
    });

    // Dedicated Pane for Highlighted Route (Above normal routes, below stations)
    const highlightPane = map.createPane('highlightPane');
    highlightPane.style.zIndex = 415;

    // Dedicated Renderer for Highlight Pane
    // This is CRITICAL: Canvas layers share a renderer by default. 
    // To physically stack them, we need a separate renderer instance on the higher pane.
    window.highlightRenderer = L.canvas({ pane: 'highlightPane', padding: 0.5, tolerance: 10 });

    // Dark Map Style (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    // Locate Control
    const LocateControl = L.Control.extend({
        options: {
            position: 'bottomleft'
        },
        onAdd: function (map) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
            const button = L.DomUtil.create('a', 'leaflet-control-locate', container);
            button.id = "btn-locate";
            button.href = "#";
            button.title = "Locate Me";
            button.role = "button";

            // Crosshair Icon (SVG)
            const arrowIcon = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" class="control-icon" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="16"></line>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                </svg>
            `;
            button.innerHTML = arrowIcon;

            let userMarker = null;
            let userPulse = null;

            const onLocate = () => {
                button.innerHTML = `
                    <svg class="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                    </svg>
                `;
                map.locate({ setView: false, enableHighAccuracy: true });
            };

            // Expose globally for main.js
            window.triggerLocate = onLocate;

            L.DomEvent.on(button, 'click', function (e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                onLocate();
            });

            map.on('locationfound', (e) => {
                // Smooth Fly
                map.flyTo(e.latlng, 15, {
                    animate: true,
                    duration: 1.5, // Faster zoom
                    easeLinearity: 0.1
                });
                // Reset Icon
                button.innerHTML = arrowIcon;

                // Show Blue Dot
                if (userMarker) {
                    userMarker.setLatLng(e.latlng);
                    userPulse.setLatLng(e.latlng);
                } else {
                    userPulse = L.circleMarker(e.latlng, {
                        radius: 12,
                        fillColor: '#3b82f6',
                        color: '#3b82f6',
                        weight: 0,
                        fillOpacity: 0.2,
                        className: 'location-pulse'
                    }).addTo(map);

                    userMarker = L.circleMarker(e.latlng, {
                        radius: 6,
                        fillColor: '#3b82f6',
                        color: '#ffffff',
                        weight: 2,
                        opacity: 1,
                        fillOpacity: 1
                    }).addTo(map);
                }
            });

            map.on('locationerror', (e) => {
                console.warn("Location access denied or failed:", e.message);
                button.innerHTML = arrowIcon; // Just reset
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

    // Zoom Level Listener for Dynamic Line Weights
    const updateLineWeights = () => {
        const zoom = map.getZoom();
        const weight = zoom <= 13 ? 1.5 : (zoom <= 15 ? 3 : 5);

        Object.values(layers.routeLayers).forEach(group => {
            group.eachLayer(layer => {
                if (layer.setStyle) layer.setStyle({ weight: weight });
            });
        });
    };

    map.on('zoomend', updateLineWeights);
    map.on('zoom', updateLineWeights);

    // Create a custom pane for trains to ensure they are always above lines
    map.createPane('trainsPane');
    map.getPane('trainsPane').style.zIndex = 650; // Above overlayPane (400) and markerPane (600)

    return map;
}

const COLOR_OFFSETS = {
    // Colors of overlapping trunk lines
    // Temporarily disabled to fix visual gaps/disconnections
    // '#0062CF': -0.04, // Blue (A,C,E)
    // '#EB6800': 0.04,  // Orange (B,D,F,M)
    // '#EE352E': -0.02, // Red (1,2,3)
    // '#00933C': 0.02,  // Green (4,5,6)
    // '#FCCC0A': 0.01   // Yellow (N,Q,R,W)
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

        // Yield to UI every 50 features to be more polite during heavy flyTo
        if (i % 50 === 0) await new Promise(r => requestAnimationFrame(r));
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
                weight: map.getZoom() <= 13 ? 2 : 3,
                opacity: 0.8,
                smoothFactor: 1.5,
                lineCap: 'round',
                lineJoin: 'round',
                pane: 'routesPane',
                className: `subway-line-${rid}`
            });

            poly.bindPopup(`Line ${rid}`);
            poly.addTo(routeGroup);
        });

        layers.routeLayers[rid] = routeGroup;
        routeGroup.addTo(layers.routes);

        // Yield every 2 routes
        if (Object.keys(layers.routeLayers).length % 2 === 0) await new Promise(r => requestAnimationFrame(r));
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
    toggleRouteLayerBatch([routeId], show);
}

export function toggleRouteLayerBatch(routeIds, show) {
    // 1. Update Visibility Filter Set
    routeIds.forEach(id => {
        if (show) {
            visibilityFilter.delete(id);
        } else {
            visibilityFilter.add(id);
            // If we are hiding this route, also remove any active highlight/overlay for it
            if (map && map.hasLayer(highlightOverlayLayer)) {
                // A bit blunt to remove the whole layer, but since highlight is usually single-route, it's safe.
                // Ideally we check if the highlight belongs to *this* route.
                // But `highlightOverlayLayer` is currently a single global group for "the" highlighted track.
                // So if ANY track is hidden, we might as well clear the highlight to be safe,
                // OR we check if we are hiding the CURRENTLY highlighted route.
                // For now, let's just clear it if the user is explicitly hiding tracks, to avoid "ghost" highlights.
                // Better: clear it only if it matches. But we don't store the "active" highlight ID easily globally.
                // Let's just clear it. It's a "reset" interaction.
                map.removeLayer(highlightOverlayLayer);
                highlightOverlayLayer.clearLayers();
            }
        }
    });

    // 2. Batch Update Layers (Use requestAnimationFrame if list is huge)
    // For < 50 items, direct manipulation is fine. For "Show All", we might want to defer.

    // We'll trust Leaflet's internal batching for now, but avoid layout thrashing 
    // by doing all adds/removes in one go.

    routeIds.forEach(routeId => {
        const layer = layers.routeLayers[routeId];
        if (!layer) return;

        const isOnMap = layers.routes.hasLayer(layer);

        if (show && !isOnMap) {
            layers.routes.addLayer(layer);
        } else if (!show && isOnMap) {
            layers.routes.removeLayer(layer);
        }
    });

    // 3. Force Train Animation Update (Optional, usually handled by next frame loop checking visibilityFilter)
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

/**
 * Brings the specified route's track to the front.
 * @param {string} routeId - The route ID (e.g. "E", "2")
 */
// Store the temporary overlay layer
let highlightOverlayLayer = L.layerGroup();

/**
 * Brings the specified route's track to the front by creating a clone in the highlightPane.
 * @param {string} routeId - The route ID (e.g. "E", "2")
 */
export function highlightRouteTrack(routeId) {
    if (!map) return;

    // 1. Clear previous highlight
    if (map.hasLayer(highlightOverlayLayer)) {
        map.removeLayer(highlightOverlayLayer);
        highlightOverlayLayer.clearLayers();
    }

    if (!routeId) return;

    const sourceLayerGroup = layers.routeLayers[routeId];
    if (!sourceLayerGroup) {
        console.warn(`[Map] No source layer found for route: ${routeId}`);
        return;
    }

    // 2. Clone features into the dedicated pane
    sourceLayerGroup.eachLayer(layer => {
        if (layer instanceof L.Polyline) {
            // Clone options but force pane and renderer
            const options = {
                ...layer.options,
                pane: 'highlightPane',
                renderer: window.highlightRenderer,
                interactive: false // Clone shouldn't steal clicks? Or maybe it should?
            };

            const latlngs = layer.getLatLngs();
            const clone = L.polyline(latlngs, options);
            highlightOverlayLayer.addLayer(clone);
        }
    });

    // 3. Add overlay to map
    if (highlightOverlayLayer.getLayers().length > 0) {
        highlightOverlayLayer.addTo(map);
    }
}
