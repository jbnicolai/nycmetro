
const API_BASE = '/api';

export async function fetchConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (!res.ok) throw new Error('Failed to fetch config');
        return await res.json();
    } catch (err) {
        console.error("API Error:", err);
        throw err;
    }
}
