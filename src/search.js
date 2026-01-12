import { renderRouteBadge } from './ui.js';

export class StationSearch {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.input = this.container.querySelector('input');
        this.resultsContainer = this.container.querySelector('#station-search-results');
        this.stations = []; // Array of { id, name, latlng, routes }
        this.routeConfigs = {};

        // Bind events
        this.input.addEventListener('input', (e) => this.handleInput(e));
        this.input.addEventListener('focus', (e) => this.handleInput(e)); // Show results on focus if text exists

        // Hide on click outside
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                this.hideResults();
            }
        });
    }

    updateIndex(stationList, routeConfigs) {
        // stationList: Array of objects from stations.js
        this.stations = stationList;
        if (routeConfigs) {
            this.routeConfigs = routeConfigs;
        }
    }

    handleInput(e) {
        const query = this.input.value.trim().toLowerCase();
        if (query.length === 0) {
            this.hideResults();
            return;
        }

        const matches = this.stations.filter(s =>
            s.name.toLowerCase().includes(query)
        );

        // Sort roughly: exact matches first, then starts with, then includes
        matches.sort((a, b) => {
            const nameA = a.name.toLowerCase();
            const nameB = b.name.toLowerCase();
            if (nameA === query) return -1;
            if (nameB === query) return 1;
            if (nameA.startsWith(query) && !nameB.startsWith(query)) return -1;
            if (!nameA.startsWith(query) && nameB.startsWith(query)) return 1;
            return 0; // Keep original order otherwise
        });

        this.renderResults(matches.slice(0, 10)); // Limit to 10
    }

    renderResults(matches) {
        this.resultsContainer.innerHTML = '';

        if (matches.length === 0) {
            const div = document.createElement('div');
            div.className = 'search-result-item no-results';
            div.textContent = 'No stations found';
            this.resultsContainer.appendChild(div);
        } else {
            matches.forEach(station => {
                const div = document.createElement('div');
                div.className = 'search-result-item';

                // Use renderRouteBadge
                let badgesHtml = '';
                if (station.routes && station.routes.length > 0) {
                    badgesHtml = station.routes.map(r => {
                        const config = this.routeConfigs[r];
                        return renderRouteBadge(r, config);
                    }).join('');
                }

                div.innerHTML = `
                    <span class="search-name">${station.name}</span>
                    <span class="search-routes-inline">${badgesHtml}</span>
                `;
                div.onclick = () => this.selectResult(station);
                this.resultsContainer.appendChild(div);
            });
        }

        this.resultsContainer.classList.remove('hidden');
    }

    selectResult(station) {
        this.input.value = station.name;
        this.hideResults();

        // Call global flyToStation
        if (window.flyToStation && station.id) {
            window.flyToStation(station.id);
        }
    }

    hideResults() {
        this.resultsContainer.classList.add('hidden');
    }
}
