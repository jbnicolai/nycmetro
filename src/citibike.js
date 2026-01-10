
const STATION_INFO_URL = "https://gbfs.citibikenyc.com/gbfs/en/station_information.json";
const STATION_STATUS_URL = "https://gbfs.citibikenyc.com/gbfs/en/station_status.json";

// We'll cache the merged data to avoid re-fetching constantly
let cachedStations = [];

export async function fetchCitibikeStations() {
    if (cachedStations.length > 0) return cachedStations;

    console.log("Fetching Citibike Data...");
    try {
        const [infoRes, statusRes] = await Promise.all([
            fetch(STATION_INFO_URL).then(r => r.json()),
            fetch(STATION_STATUS_URL).then(r => r.json())
        ]);

        const infoMap = new Map();
        infoRes.data.stations.forEach(s => infoMap.set(s.station_id, s));

        const stations = [];
        statusRes.data.stations.forEach(status => {
            const info = infoMap.get(status.station_id);
            if (info) {
                stations.push({
                    ...info,
                    ...status,
                    lat: info.lat,
                    lon: info.lon
                });
            }
        });

        cachedStations = stations;
        return stations;
    } catch (err) {
        console.error("Failed to fetch Citibike data", err);
        return [];
    }
}

export function filterCitibikeStations(stations, type) {
    return stations.filter(s => {
        const bikes = s.num_bikes_available || 0;
        const ebikes = s.num_ebikes_available || 0;
        const docks = s.num_docks_available || 0;

        if (type === 'green') return ebikes >= 3;
        if (type === 'yellow') return bikes > 0 && ebikes < 3;
        if (type === 'red') return bikes === 0;
        return false;
    });
}
