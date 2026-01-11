
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

export function getDelayInSeconds(rt, scheduledStop) {
    if (!rt || !scheduledStop) return 0;

    // Normalize RT Time (Unix Epoch) to Seconds Since Midnight local time
    const rtDate = new Date(rt.time * 1000);
    const rtSeconds = rtDate.getHours() * 3600 + rtDate.getMinutes() * 60 + rtDate.getSeconds();

    // Handle potential day wrapping comparison
    let diff = rtSeconds - scheduledStop.time;
    if (diff < -43200) diff += 86400;
    if (diff > 43200) diff -= 86400;

    return diff;
}
