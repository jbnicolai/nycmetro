
export function formatTime(s) {
    if (s === undefined || s === null) return "--:--";
    const effectiveSeconds = s % 86400;
    const date = new Date(effectiveSeconds * 1000);
    // Use UTC to avoid timezone shifts since effectiveSeconds is from midnight
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'UTC'
    });
}

export function parseProperties(feature) {
    const props = feature.properties;
    let name = props.name || "Station";
    let lines = [];

    // Parse Socrata HTML Description if present
    if (props.description) {
        const div = document.createElement('div');
        div.innerHTML = props.description;
        div.querySelectorAll('li').forEach(row => {
            const label = row.querySelector('.atr-name')?.textContent;
            const val = row.querySelector('.atr-value')?.textContent;
            if (label === 'NAME') name = val;
            if (label === 'LINE') lines = val.split('-');
        });
    }

    // Fallback parsing
    if (lines.length === 0) lines = (props.line || props.lines || props.Line || "").split(/[- ]/);

    return { name, lines };
}

export function unixToSecondsSinceMidnight(unixParams) {
    if (!unixParams) return 0;
    const d = new Date(unixParams * 1000);
    // Use formatToParts for maximum robustness regardless of locale/browser
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false
    });

    try {
        const parts = formatter.formatToParts(d);
        const h = parseInt(parts.find(p => p.type === 'hour').value);
        const m = parseInt(parts.find(p => p.type === 'minute').value);
        const s = parseInt(parts.find(p => p.type === 'second').value);
        return h * 3600 + m * 60 + s;
    } catch (e) {
        console.error("Time calculation failure:", e);
        // Fallback to local if NYC fails (better than NaN)
        return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }
}

export function getDelayInSeconds(rt, scheduledStop) {
    if (!rt || !scheduledStop) return 0;

    // Normalize RT Time (Unix Epoch) to Seconds Since Midnight local time
    const rtSeconds = unixToSecondsSinceMidnight(rt.time);

    // Handle potential day wrapping comparison
    let diff = rtSeconds - scheduledStop.time;
    if (diff < -43200) diff += 86400;
    if (diff > 43200) diff -= 86400;

    return diff;
}

export function getContrastColor(hexColor) {
    if (!hexColor) return '#000';
    // Handle short hex #333
    if (hexColor.length === 4) {
        hexColor = '#' + hexColor[1] + hexColor[1] + hexColor[2] + hexColor[2] + hexColor[3] + hexColor[3];
    }
    const r = parseInt(hexColor.substr(1, 2), 16);
    const g = parseInt(hexColor.substr(3, 2), 16);
    const b = parseInt(hexColor.substr(5, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000' : '#fff';
}

export const yieldToMain = () => {
    return new Promise(resolve => {
        // Use requestAnimationFrame for higher priority tasks if needed, 
        // but setTimeout(0) is standard for yielding to the event loop.
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => resolve(), { timeout: 100 });
        } else {
            setTimeout(resolve, 0);
        }
    });
};

/** Normalizes route IDs (e.g. "01" -> "1") for cross-feed consistency */
export const normId = (id) => {
    if (!id) return "";
    const s = String(id);
    return s.startsWith('0') && s.length > 1 ? s.substring(1) : s;
};
