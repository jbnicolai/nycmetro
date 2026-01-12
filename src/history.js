/**
 * URL State Management for Deep Linking
 * Handles URL hash-based navigation to stations and trains
 * Designed to support future migration to pushState for browser history
 */

// Current state cache
let currentState = { type: null, id: null };
let hashChangeListeners = [];

/**
 * Parse URL hash into state object
 * @returns {Object} { type: 'station'|'train'|null, id: string|null }
 */
export function parseHash() {
    const hash = window.location.hash.slice(1); // Remove '#'
    
    if (!hash) {
        return { type: null, id: null };
    }
    
    const parts = hash.split('/');
    
    if (parts.length === 2) {
        const [type, id] = parts;
        
        if (type === 'station' || type === 'train') {
            return { type, id: decodeURIComponent(id) };
        }
    }
    
    // Invalid format
    console.warn('[History] Invalid hash format:', hash);
    return { type: null, id: null };
}

/**
 * Update URL hash without page reload
 * @param {string|null} type - 'station', 'train', or null to clear
 * @param {string|null} id - Station or train ID
 * @param {Object} options - { replace: boolean } - use replaceState instead of pushState
 */
export function updateHash(type, id, options = {}) {
    const { replace = false } = options;
    
    let newHash = '';
    
    if (type && id) {
        newHash = `#${type}/${encodeURIComponent(id)}`;
    }
    
    // Update current state
    currentState = { type, id };
    
    // Update URL
    if (replace) {
        window.history.replaceState(null, '', newHash || '#');
    } else {
        // For now, just update hash (will trigger hashchange event)
        // In future pushState implementation, we'll use history.pushState here
        if (window.location.hash !== newHash) {
            window.location.hash = newHash;
        }
    }
}

/**
 * Get initial state from URL on page load
 * @returns {Object} { type, id }
 */
export function getInitialState() {
    const state = parseHash();
    currentState = state;
    return state;
}

/**
 * Register callback for hash changes
 * @param {Function} callback - Called with (newState, oldState)
 */
export function onHashChange(callback) {
    hashChangeListeners.push(callback);
}

/**
 * Get current state
 * @returns {Object} { type, id }
 */
export function getCurrentState() {
    return { ...currentState };
}

// Listen for hash changes (browser back/forward)
window.addEventListener('hashchange', () => {
    const oldState = { ...currentState };
    const newState = parseHash();
    currentState = newState;
    
    // Notify all listeners
    hashChangeListeners.forEach(listener => {
        try {
            listener(newState, oldState);
        } catch (e) {
            console.error('[History] Listener error:', e);
        }
    });
});
