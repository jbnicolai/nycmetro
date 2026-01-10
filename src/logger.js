
// Override console methods to ship logs to backend
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function sendLog(level, args) {
    // Convert args to string
    const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');

    // Check for "dev mode"
    const params = new URLSearchParams(window.location.search);
    if (!params.has('debug')) return;

    // Fire and forget fetch
    fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message, timestamp: Date.now() })
    }).catch(e => { }); // Ignore logging errors to prevent loops
}

console.log = function (...args) {
    originalLog.apply(console, args);
    sendLog('INFO', args);
};

console.warn = function (...args) {
    originalWarn.apply(console, args);
    sendLog('WARN', args);
};

console.error = function (...args) {
    originalError.apply(console, args);
    sendLog('ERROR', args);
};

console.log("[Logger] Remote logging initialized.");
