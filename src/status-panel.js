export const StatusPanel = {
    init(map) {
        // Create container if not exists
        if (document.getElementById('status-panel')) return;

        // 1. Create the Panel (Hidden initially)
        const panel = document.createElement('div');
        panel.id = 'status-panel';
        panel.className = 'status-panel'; // Default is hidden via CSS or js
        // Note: We'll rely on a separate toggle button now.
        // But we keep the internal structure for content.
        panel.innerHTML = `
            <div class="status-header">
                <span class="status-title">> SYSTEM_STATUS</span>
                <button id="close-status" class="status-toggle">x</button>
            </div>
            <div id="status-content" class="status-content">
                <div class="status-row">
                    <span class="status-key">TIME:</span>
                    <span class="status-value" id="status-time">--:--:--</span>
                </div>
                <div class="status-row">
                    <span class="status-key">VER:</span>
                    <span class="status-value" id="status-version">--</span>
                </div>
                <div class="status-row">
                    <span class="status-key">FPS:</span>
                    <span class="status-value" id="status-fps">60</span>
                </div>
                <div class="status-separator">---</div>
                <div class="status-row">
                    <span class="status-key">ROUTES:</span>
                    <span class="status-value" id="status-routes">0</span>
                </div>
                <div class="status-row">
                    <span class="status-key">TRAINS:</span>
                    <span class="status-value" id="status-trains">0</span>
                </div>
                <div class="status-row">
                    <span class="status-key">STATIONS:</span>
                    <span class="status-value" id="status-stations">0</span>
                </div>
                <div class="status-separator">---</div>
                <div class="status-row">
                    <span class="status-key">CITIBIKE:</span>
                    <span class="status-value" id="status-citibike-total">Idle</span>
                </div>
                <div id="citibike-details" style="display:none; padding-left:10px; font-size: 0.9em; color:#aaa;">
                    <div style="display:flex; justify-content:space-between;">
                        <span>Empty:</span> <span id="status-citi-empty" style="color:#ef4444">-</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span>Normal Bikes Only:</span> <span id="status-citi-normal-only" style="color:#fbbf24">-</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span>With E-Bikes:</span> <span id="status-citi-ebike" style="color:#22c55e">-</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                         <span>Total Bikes:</span> <span id="status-citi-bikes" style="color:#fff">-</span>
                    </div>
                </div>
                <div id="status-log" class="status-log"></div>
            </div>
        `;

        // Append panel to body (overlay)
        document.body.appendChild(panel);

        // Initial State: Hidden
        panel.style.display = 'none';

        // 2. Add Leaflet Control for Toggle
        if (map) {
            const DebugControl = L.Control.extend({
                options: { position: 'bottomleft' },
                onAdd: function () {
                    const btn = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
                    const link = L.DomUtil.create('a', 'leaflet-control-debug', btn);
                    link.href = '#';
                    link.title = 'Toggle Debug Panel';
                    link.role = 'button';
                    link.innerHTML = '>'; // Integrated style
                    link.style.fontWeight = 'bold';
                    link.style.fontSize = '14px';
                    link.style.color = '#000'; // Match standard leaflet controls logic (user can customize)

                    L.DomEvent.on(link, 'click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        L.DomEvent.preventDefault(e);
                        const isVisible = panel.style.display === 'block';
                        panel.style.display = isVisible ? 'none' : 'block';
                    });

                    return btn;
                }
            });
            map.addControl(new DebugControl());
        }

        // Close Button Logic
        const closeBtn = document.getElementById('close-status');
        if (closeBtn) {
            closeBtn.onclick = () => {
                panel.style.display = 'none';
            };
        }

        this.log("System Initialized.");
    },

    update(key, value) {
        const el = document.getElementById(`status-${key}`);
        if (el) {
            el.innerHTML = value;
        } else {
            console.warn(`[StatusPanel] Missing element for key: ${key}`);
        }
    },

    log(msg) {
        const log = document.getElementById('status-log');
        if (!log) return;
        const line = document.createElement('div');
        line.className = 'status-log-line';
        line.textContent = `> ${msg}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;

        // Keep log short
        if (log.children.length > 50) {
            log.removeChild(log.firstChild);
        }
    },

    showUpdateBanner(newVersion) {
        let banner = document.getElementById('update-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'update-banner';
            banner.className = 'update-banner';
            banner.innerHTML = `
                <span>Update Available (${newVersion})</span>
                <button onclick="window.location.reload()">Refresh</button>
            `;
            document.body.appendChild(banner);
        }
        banner.style.display = 'flex';
    }
};
