export const StatusPanel = {
    init() {
        // Create container if not exists
        if (document.getElementById('status-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'status-panel';
        panel.className = 'status-panel';
        panel.innerHTML = `
            <div class="status-header">
                <span class="status-title">> SYSTEM_STATUS</span>
                <button id="toggle-status" class="status-toggle">_</button>
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
        // Default to collapsed
        panel.classList.add('collapsed');
        document.body.appendChild(panel);

        // Toggle Logic
        const header = panel.querySelector('.status-header');
        const content = document.getElementById('status-content');
        const toggleBtn = document.getElementById('toggle-status');

        // Initial State
        content.style.display = 'none';

        const toggle = () => {
            const isCollapsed = panel.classList.toggle('collapsed');
            content.style.display = isCollapsed ? 'none' : 'block';
            toggleBtn.textContent = isCollapsed ? '+' : '_'; // Though header is hidden when collapsed
        };

        header.addEventListener('click', toggle);
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent header click
            toggle();
        });

        // Allow clicking the collapsed "bubble" to expand
        panel.addEventListener('click', (e) => {
            if (panel.classList.contains('collapsed')) {
                toggle();
            }
        });

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
    }
};
