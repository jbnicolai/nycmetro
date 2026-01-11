
let alertsInterval = null;
let activeAlerts = [];

// DOM Elements
let statusElement = null;
let modalElement = null;

export async function initAlerts(legendElement) {
    if (!legendElement) return;

    // 1. Create Status Row in Legend
    // We expect the legend to have a specific container or we append to it
    const legendContent = legendElement.querySelector('.legend-content');
    if (legendContent) {
        const statusRow = document.createElement('div');
        statusRow.className = 'legend-section';
        statusRow.style.borderTop = '1px solid #333';
        statusRow.style.marginTop = '10px';
        statusRow.style.paddingTop = '10px';
        statusRow.innerHTML = `
            <div class="legend-title">Service Status</div>
            <div id="service-status-text" style="font-size:0.9em; cursor:pointer; color:#aaa;">
                ⏳ Checking...
            </div>
        `;
        legendContent.appendChild(statusRow);

        statusElement = statusRow.querySelector('#service-status-text');
        statusElement.addEventListener('click', showAlertsModal);
    }

    // 2. Create Modal (Hidden by default)
    createModal();

    // 3. Start Polling
    fetchAlerts();
    alertsInterval = setInterval(fetchAlerts, 60000); // 1 min
}

function createModal() {
    modalElement = document.createElement('div');
    modalElement.id = 'alerts-modal';
    modalElement.className = 'modal hidden';
    modalElement.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>⚠️ Service Alerts</h2>
                <button id="close-alerts">×</button>
            </div>
            <div id="alerts-list" class="modal-body">
                <!-- Alerts go here -->
            </div>
        </div>
    `;
    document.body.appendChild(modalElement);

    // Close logic
    document.getElementById('close-alerts').addEventListener('click', () => {
        modalElement.classList.add('hidden');
    });

    // Close on click outside
    modalElement.addEventListener('click', (e) => {
        if (e.target === modalElement) modalElement.classList.add('hidden');
    });
}

function showAlertsModal() {
    if (activeAlerts.length === 0) return;

    const list = document.getElementById('alerts-list');
    list.innerHTML = '';

    activeAlerts.forEach(alert => {
        const item = document.createElement('div');
        item.className = 'alert-item';

        // Routes badges
        const badges = alert.routes.map(r => `<span class="route-badge badge-${r}">${r}</span>`).join(' ');

        item.innerHTML = `
            <div class="alert-header">
                <div class="alert-routes">${badges}</div>
                <h3>${alert.header || 'Service Alert'}</h3>
            </div>
            <div class="alert-desc">${formatDescription(alert.description)}</div>
        `;
        list.appendChild(item);
    });

    modalElement.classList.remove('hidden');
}

function formatDescription(text) {
    if (!text) return "";
    return text.replace(/\n/g, '<br>');
}

async function fetchAlerts() {
    try {
        const res = await fetch('/api/alerts');
        if (res.ok) {
            const data = await res.json();
            activeAlerts = data || [];
            updateStatusUI();
        }
    } catch (e) {
        console.warn("Failed to fetch alerts", e);
        if (statusElement) statusElement.textContent = "❌ Connection Error";
    }
}

function updateStatusUI() {
    if (!statusElement) return;

    if (activeAlerts.length === 0) {
        statusElement.innerHTML = `<span style="color:#22c55e">✅ Good Service</span>`;
        statusElement.style.pointerEvents = 'none';
    } else {
        statusElement.innerHTML = `<span style="color:#fbbf24">⚠️ ${activeAlerts.length} Active Alerts</span> <span style="font-size:0.8em; text-decoration:underline;">(View)</span>`;
        statusElement.style.pointerEvents = 'auto';
    }
}

export function getActiveAlerts() {
    return activeAlerts;
}
