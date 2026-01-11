
export function formatTime(s) {
    if (s === undefined || s === null) return "--:--";
    const date = new Date(s * 1000); // Input is seconds, Date takes ms
    // Format to HH:MM:SS, using simple slice
    return date.toISOString().substr(11, 8);
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
