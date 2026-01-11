
export let routeGroupsCopy = {}; // Internal state for filtering

export function createLegend(map, layers, fetchCitibikeFn) {
    // 1. Create the FAB (using Leaflet Control to respect map boundaries/zIndex)
    const fabControl = L.control({ position: 'bottomright' });

    fabControl.onAdd = function () {
        const btn = L.DomUtil.create('div', 'legend-fab');
        btn.innerHTML = `<svg class="legend-icon" viewBox="0 0 24 24"><path d="M11.99 2.005L21.995 7.002L12 12L2.002 7.002L11.99 2.005ZM3.701 9.692L12 13.842L20.295 9.694L21.995 10.544L12 15.544L2.002 10.544L3.701 9.692ZM3.701 13.233L12 17.383L20.295 13.235L21.995 14.085L12 19.085L2.002 14.085L3.701 13.233Z"></path></svg>`;

        // Fix: Prevent double click from zooming map
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.disableScrollPropagation(btn);

        btn.onclick = () => {
            const panel = document.getElementById('legend-panel');
            if (panel) panel.classList.toggle('visible');
        };
        return btn;
    };
    fabControl.addTo(map);

    // 2. Create the Panel (Appended to Map Container for specific positioning)
    const mapContainer = map.getContainer();
    const panel = document.createElement('div');
    panel.id = 'legend-panel';
    panel.className = 'legend-panel';

    // Prevent map interactions through the panel
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.disableScrollPropagation(panel);

    panel.innerHTML = `
        <div class="legend-header-row">
            <span class="legend-title-main">Map Layers</span>
            <button class="legend-close" aria-label="Close" onclick="document.getElementById('legend-panel').classList.remove('visible')">×</button>
        </div>
        <div class="legend-scroll-area">
            
            <!-- Subway Lines Filter -->
             <div class="legend-section-title">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span>Subway Lines</span>
                    <button id="btn-toggle-tracks" class="btn-master-toggle" style="opacity: 1; color: var(--accent-color);">Hide Tracks</button>
                </div>
                <button id="btn-toggle-all" class="btn-master-toggle">Hide All</button>
            </div>
            <div id="subway-toggles"></div>

            <!-- Citibike Section -->
            <div class="legend-section-title">
                <span>Citibike Availability</span>
                <button id="btn-citi-toggle-all" class="btn-master-toggle">Hide All</button>
            </div>
            <div id="citibike-toggles">
                 ${createToggleRow('cb-green', '#22c55e', '3+ E-bikes')}
                 ${createToggleRow('cb-yellow', '#fbbf24', 'Low / Classic')}
                 ${createToggleRow('cb-red', '#ef4444', 'Empty Station')}
            </div>

             <div style="margin-top:25px; border-top:1px solid rgba(255,255,255,0.1); padding-top:15px; font-size:0.8em; text-align:center;">
                <a href="https://github.com/jbnicolai/nycmetro" target="_blank" style="color:rgba(255,255,255,0.5); text-decoration:none;">
                     View on GitHub ↗
                </a>
            </div>
        </div>
    `;

    mapContainer.appendChild(panel);

    // --- Event Listeners ---

    // Tracks Toggle (Button)
    setTimeout(() => {
        const trackBtn = document.getElementById('btn-toggle-tracks');
        let tracksVisible = true;

        if (trackBtn) {
            trackBtn.onclick = () => {
                tracksVisible = !tracksVisible;
                if (tracksVisible) {
                    layers.routes.addTo(map);
                    trackBtn.innerText = "Hide Tracks";
                    trackBtn.style.color = "var(--accent-color)";
                    trackBtn.style.opacity = "1";
                } else {
                    layers.routes.removeFrom(map);
                    trackBtn.innerText = "Show Tracks";
                    trackBtn.style.color = "rgba(255,255,255,0.5)";
                    trackBtn.style.opacity = "0.7";
                }
            };
        }
    }, 100);

    // Citibike Listeners
    setTimeout(() => {
        // Individual Toggles
        const ids = ['cb-green', 'cb-yellow', 'cb-red'];
        const container = document.getElementById('citibike-toggles');
        const masterToggle = document.getElementById('btn-citi-toggle-all');

        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    const color = id.split('-')[1];
                    fetchCitibikeFn(color, e.target.checked);
                    updateCitiMasterState();
                });
            }
        });

        // Master Toggle Logic
        if (masterToggle) {
            // Init State
            updateCitiMasterState();

            masterToggle.onclick = () => {
                const isHideAll = masterToggle.textContent === 'Hide All';
                const newState = !isHideAll;

                ids.forEach(id => {
                    const el = document.getElementById(id);
                    if (el && el.checked !== newState) {
                        el.checked = newState;
                        // Manually trigger change
                        const event = new Event('change');
                        el.dispatchEvent(event);
                    }
                });
                updateCitiMasterState();
            };
        }

        function updateCitiMasterState() {
            const inputs = ids.map(id => document.getElementById(id)).filter(el => el);
            if (inputs.length === 0) return;
            const allChecked = inputs.every(i => i.checked);
            const someChecked = inputs.some(i => i.checked);

            if (allChecked) masterToggle.textContent = 'Hide All';
            else if (!someChecked) masterToggle.textContent = 'Show All';
            else masterToggle.textContent = 'Show All';
        }

    }, 100);
}

function createToggleRow(id, color, label) {
    return `
        <div class="legend-row">
            <label class="legend-label">
                <input type="checkbox" id="${id}" class="legend-checkbox"> 
                <span class="legend-swatch" style="background:${color}"></span> 
                <span class="route-text">${label}</span>
            </label>
        </div>
    `;
}

export function updateLegendLines(routes, toggleCallback) {
    const container = document.getElementById('subway-toggles');
    const masterToggle = document.getElementById('btn-toggle-all');
    if (!container) return;

    container.innerHTML = '';
    routeGroupsCopy = {};

    // 1. Group by Color
    if (routes) {
        Object.values(routes).forEach(r => {
            if (!r) return;
            const color = r.color || '#888';
            if (!routeGroupsCopy[color]) routeGroupsCopy[color] = [];
            routeGroupsCopy[color].push(r);
        });
    }

    // 2. Sort Groups (Alphabetically by first route's name)
    const sortedColors = Object.keys(routeGroupsCopy).sort((a, b) => {
        const rA = routeGroupsCopy[a][0];
        const rB = routeGroupsCopy[b][0];
        if (!rA || !rB) return 0;
        return rA.short_name.localeCompare(rB.short_name);
    });

    // 3. Render Groups
    sortedColors.forEach(color => {
        const groupRoutes = routeGroupsCopy[color];
        groupRoutes.sort((a, b) => a.short_name.localeCompare(b.short_name));

        const names = groupRoutes.map(r => r.short_name).join(', ');
        const routeIds = groupRoutes.map(r => r.id);

        const row = document.createElement('div');
        row.className = 'legend-row';
        row.innerHTML = `
            <label class="legend-label">
                <input type="checkbox" class="legend-checkbox" checked data-color="${color}"> 
                <span class="legend-swatch" style="background: ${color}"></span> 
                <span class="route-text">${names}</span>
            </label>
            <button class="btn-focus" title="Show Only ${names}">ONLY</button>
        `;

        // Checkbox Logic
        const checkbox = row.querySelector('input');
        checkbox.addEventListener('change', (e) => {
            const checked = e.target.checked;
            toggleCallback(routeIds, checked);
            updateMasterToggleState();
        });

        // "ONLY" Button Logic (Focus Mode)
        const focusBtn = row.querySelector('.btn-focus');
        focusBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent label click

            const idsToHide = [];
            const idsToShow = [];

            // 1. Uncheck ALL other checkboxes and collect IDs to hide
            document.querySelectorAll('#subway-toggles input[type="checkbox"]').forEach(cb => {
                if (cb !== checkbox) {
                    if (cb.checked) {
                        cb.checked = false;
                        const otherColor = cb.dataset.color;
                        if (routeGroupsCopy[otherColor]) {
                            routeGroupsCopy[otherColor].forEach(r => idsToHide.push(r.id));
                        }
                    }
                }
            });

            // 2. Check THIS checkbox if not already and collect IDs to show
            if (!checkbox.checked) {
                checkbox.checked = true;
                routeIds.forEach(id => idsToShow.push(id));
            } else {
                // Even if checked, we might need to ensure they are shown (idempotent)
                // But typically if checked, they are shown. 
                // However, "ONLY" implies ensuring these are the ONLY ones.
                // If already checked, we don't need to add to idsToShow, just ensure others are hidden.
            }

            // Batch Updates
            if (idsToHide.length > 0) toggleCallback(idsToHide, false);
            if (idsToShow.length > 0) toggleCallback(idsToShow, true);

            updateMasterToggleState();
        });

        container.appendChild(row);
    });

    // 4. Master Toggle Logic
    if (masterToggle) {
        masterToggle.onclick = () => {
            const inputs = container.querySelectorAll('input');
            const isHideAll = masterToggle.textContent === 'Hide All';
            const newState = !isHideAll;

            // 1. Immediate UI Feedback
            masterToggle.disabled = true;
            masterToggle.textContent = 'Processing...';
            masterToggle.style.opacity = '0.7';
            masterToggle.style.cursor = 'wait';

            // 2. Defer heavy work to allow UI repaint
            setTimeout(() => {
                const idsToUpdate = [];

                // UI Update Loop (fast)
                inputs.forEach(input => {
                    input.checked = newState;
                    const color = input.dataset.color;
                    if (routeGroupsCopy[color]) {
                        routeGroupsCopy[color].forEach(r => idsToUpdate.push(r.id));
                    }
                });

                // Heavy Batch Call
                if (idsToUpdate.length > 0) {
                    toggleCallback(idsToUpdate, newState); // This is the blocker
                }

                // 3. Reset UI
                updateMasterToggleState();
                masterToggle.disabled = false;
                masterToggle.style.opacity = '1';
                masterToggle.style.cursor = 'pointer';
            }, 50); // Small delay to ensure render happens
        };
    }

    function updateMasterToggleState() {
        const inputs = Array.from(container.querySelectorAll('input'));
        const allChecked = inputs.every(i => i.checked);
        const someChecked = inputs.some(i => i.checked);

        if (allChecked) masterToggle.textContent = 'Hide All';
        else if (!someChecked) masterToggle.textContent = 'Show All';
        else masterToggle.textContent = 'Show All'; // Mixed state defaults to allowing "Show All"
    }
}
