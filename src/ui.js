import { formatTime, getContrastColor } from './utils.js';

/**
 * Renders the route badge (e.g. "1", "A", "L")
 */
export function renderRouteBadge(routeId, routeInfo) {
    const color = routeInfo ? routeInfo.color : '#666';
    const textColor = getContrastColor(color);
    return `<span class="station-badge" style="background-color: ${color}; color: ${textColor};">${routeId}</span>`;
}

/**
 * Renders the status badge (Live, Delayed, Scheduled, Approaching)
 */
export function renderStatusBadge(minsUntil, isLive, isAtStation) {
    if (!isLive) {
        // Scheduled: Show countdown in gray
        const text = minsUntil <= 0 ? "Now" : `${minsUntil} min`;
        return `<span class="status-badge status-scheduled">${text}</span>`;
    }

    // Real-Time
    if (isAtStation || minsUntil <= 0) {
        return `<span class="status-badge status-at-station">At Station</span>`;
    }

    if (minsUntil < 1) {
        return `<span class="status-badge status-live">Arriving</span>`;
    }

    // Live Countdown
    return `<span class="status-badge status-live">${minsUntil} min</span>`;
}

/**
 * Renders a row in the train tooltip timeline
 */
export function renderTimelineRow(stop, isNext, isPast, color, delay) {
    const predictedTime = stop.time + (delay || 0);
    const timeStr = formatTime(predictedTime);

    let rowClass = "train-stop-row";
    if (isPast) rowClass += " stop-past";
    if (isNext) rowClass += " stop-next";

    // We assume 'stop.name' is pre-resolved or we pass a getName helper. 
    // Let's pass the resolved name to keep this pure.

    const dotStyle = `border-color:${color}; background:${isNext ? color : 'transparent'}`;
    const pulseClass = isNext ? 'pulse' : '';

    return `
    <div class="${rowClass}" onclick="window.flyToStation('${stop.id}')">
        <div class="train-stop-left">
                <div class="timeline-dot ${pulseClass}" style="${dotStyle}"></div>
                <span class="train-stop-name">${stop.name}</span>
        </div>
        <div class="train-stop-time">${timeStr}</div>
    </div>`;
}

/**
 * Renders the Train Tooltip Footer (Start/End links)
 */
export function renderTrainFooter(startStop, endStop, duration) {
    const startName = startStop.name;
    const endName = endStop.name;
    const startTimeStr = formatTime(startStop.time);
    const endTimeStr = formatTime(endStop.time);

    return `
    <div class="train-footer">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <span style="color:#94a3b8;">Start: 
                <a href="#" onclick="event.preventDefault(); window.flyToStation('${startStop.id}');" class="station-link" style="color:#cbd5e1; font-weight:normal;">${startName}</a>
            </span>
            <span style="color:#94a3b8;">${startTimeStr}</span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <span style="color:#94a3b8;">End: 
                <a href="#" onclick="event.preventDefault(); window.flyToStation('${endStop.id}');" class="station-link" style="color:#cbd5e1; font-weight:normal;">${endName}</a>
            </span>
            <span style="color:#94a3b8;">${endTimeStr}</span>
        </div>
        <div style="display:flex; justify-content:center; margin-top:8px; border-top:1px solid rgba(255,255,255,0.1); padding-top:6px;">
            <span style="color:#64748b; font-size:0.9em;">Duration: ${duration} min</span>
        </div>
    </div>`;
}
