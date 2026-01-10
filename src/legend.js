
export function createLegend(map, layers, fetchCitibikeFn) {
    const legend = L.control({ position: 'bottomright' });

    legend.onAdd = function () {
        const div = L.DomUtil.create('div', 'legend-control');

        // Prevent map clicks propagating through legend
        L.DomEvent.disableClickPropagation(div);

        div.innerHTML = `
            <div class="legend-header">
                <span>Map Layers</span>
                <button class="legend-toggle" aria-label="Toggle Legend">_</button>
            </div>
            <div class="legend-content">
                <div class="legend-section">
                    <div class="legend-title">Citibike (Click to Load)</div>
                    <label class="legend-item"><input type="checkbox" id="cb-green"> <span class="color-swatch" style="background:#22c55e"></span> 3+ E-bikes</label>
                    <label class="legend-item"><input type="checkbox" id="cb-yellow"> <span class="color-swatch" style="background:#fbbf24"></span> Low/Classic</label>
                    <label class="legend-item"><input type="checkbox" id="cb-red"> <span class="color-swatch" style="background:#ef4444"></span> Empty</label>
                </div>
                <div class="legend-section"><div class="legend-title">Subway Lines</div><div id="subway-toggles"></div></div>
                <div style="margin-top:15px; border-top:1px solid rgba(255,255,255,0.1); padding-top:10px; font-size:0.8em; text-align:center;">
                    <a href="https://github.com/jbnicolai/nycmetro" target="_blank" style="color:rgba(255,255,255,0.5); text-decoration:none;">
                         View on GitHub ↗
                    </a>
                </div>
            </div>`;

        // Toggle Logic
        const header = div.querySelector('.legend-header');
        const toggleBtn = div.querySelector('.legend-toggle');
        const content = div.querySelector('.legend-content');

        // Default to expanded for clearer UX
        // div.classList.add('collapsed'); 
        toggleBtn.textContent = '_';
        content.style.display = 'block';

        header.addEventListener('click', () => {
            const isCollapsed = div.classList.toggle('collapsed');
            content.style.display = isCollapsed ? 'none' : 'block';
            toggleBtn.textContent = isCollapsed ? '+' : '_';
        });

        // Citibike Listeners

        // Citibike Listeners
        setTimeout(() => {
            ['cb-green', 'cb-yellow', 'cb-red'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', (e) => {
                        const color = id.split('-')[1];
                        fetchCitibikeFn(color, e.target.checked);
                    });
                }
            });
        }, 100);

        return div;
    };
    legend.addTo(map);
}

export function updateLegendLines(routes, toggleCallback) {
    const container = document.querySelector('#subway-toggles');
    if (!container) return;

    container.innerHTML = '';

    // 1. Group by Color
    const groups = {};
    if (routes) {
        Object.values(routes).forEach(r => {
            if (!r) return;
            const color = r.color || '#888';
            if (!groups[color]) groups[color] = [];
            groups[color].push(r);
        });
    }

    // 2. Sort Groups (Alphabetically by first route's name)
    const sortedColors = Object.keys(groups).sort((a, b) => {
        const rA = groups[a][0];
        const rB = groups[b][0];
        if (!rA || !rB) return 0;

        return rA.short_name.localeCompare(rB.short_name);
    });

    // 3. Render
    sortedColors.forEach(color => {
        const groupRoutes = groups[color];
        // Sort routes inside the group too
        groupRoutes.sort((a, b) => a.short_name.localeCompare(b.short_name));

        const names = groupRoutes.map(r => r.short_name).join(', ');
        const routeIds = groupRoutes.map(r => r.id);

        const label = document.createElement('label');
        label.className = 'legend-item';
        label.innerHTML = `
            <input type="checkbox" checked> 
            <span class="color-swatch" style="background: ${color}; width: 12px; height: 12px; display:inline-block; border-radius:50%; margin-right:5px;"></span> 
            <span style="font-weight:500;">${names}</span>
        `;

        label.querySelector('input').addEventListener('change', (e) => {
            const checked = e.target.checked;
            routeIds.forEach(id => toggleCallback(id, checked));
        });

        container.appendChild(label);
    });
}
