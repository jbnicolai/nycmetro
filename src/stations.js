
import { parseProperties } from './utils.js';

export function renderStations(geoJson, layerGroup) {
    L.geoJSON(geoJson, {
        pointToLayer: (feature, latlng) => {
            if (!latlng || isNaN(latlng.lat) || isNaN(latlng.lng)) {
                console.warn("Invalid station coordinates:", feature);
                return null;
            }
            return L.circleMarker(latlng, { radius: 3, fillColor: '#ffffff', color: '#000', weight: 1, opacity: 1, fillOpacity: 0.8 });
        },
        onEachFeature: (feature, layer) => {
            if (!layer) return; // Skip if null return from pointToLayer
            const { name } = parseProperties(feature);
            layer.bindTooltip(name, { direction: 'top', className: 'subway-label' });
            layer.on('click', () => showStationPopup(name, layer));
        }
    }).addTo(layerGroup);
}

function showStationPopup(name, layer) {
    const nTime = Math.floor(Math.random() * 8) + 1;
    const sTime = Math.floor(Math.random() * 8) + 1;
    layer.bindPopup(`
        <div style="min-width: 150px;">
            <h3>${name}</h3>
            <div><strong>Northbound:</strong> ${nTime} min<br><strong>Southbound:</strong> ${sTime} min</div>
            <div style="font-size:0.7rem; color:#666; margin-top:5px;">Scheduled Arrivals</div>
        </div>
    `).openPopup();
}
