import urllib.request
import zipfile
import io
import csv
import json
import os
import time
import argparse
from collections import defaultdict

# --- Configuration ---
DATA_DIR = "data"
GTFS_DIR = os.path.join(DATA_DIR, "gtfs")
MTA_GTFS_URL = "http://web.mta.info/developers/data/nyct/subway/google_transit.zip"
CACHE_FILE = os.path.join(DATA_DIR, "google_transit.zip")

# Output Files
CONFIG_FILE = os.path.join(DATA_DIR, "subway_config.json")
SCHEDULE_FILE = os.path.join(DATA_DIR, "subway_schedule.json")

# Constants
CACHE_DURATION = 3600  # 1 hour
SERVICE_ID = "Weekday" # Default service ID for schedule generation

def ensure_dirs():
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR)
    if not os.path.exists(GTFS_DIR):
        os.makedirs(GTFS_DIR)

def download_gtfs(force=False):
    """Downloads GTFS zip from MTA if not cached or forced."""
    ensure_dirs()
    
    needs_download = True
    if os.path.exists(CACHE_FILE) and not force:
        mtime = os.path.getmtime(CACHE_FILE)
        if time.time() - mtime < CACHE_DURATION:
            needs_download = False
            print("Using cached GTFS data.")

    if needs_download:
        print(f"Downloading GTFS data from {MTA_GTFS_URL}...")
        try:
            with urllib.request.urlopen(MTA_GTFS_URL) as response:
                content = response.read()
                with open(CACHE_FILE, 'wb') as out_file:
                    out_file.write(content)
            
            # Extract to GTFS_DIR for schedule processing
            print("Extracting GTFS data...")
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                z.extractall(GTFS_DIR)
                
            print("Download and extraction complete.")
        except Exception as e:
            print(f"Error downloading GTFS data: {e}")
            if not os.path.exists(CACHE_FILE):
                raise

def process_map_data():
    """Generates subway_config.json (Routes & Shapes)"""
    print("Processing Map Data (Routes & Shapes)...")
    subway_data = {}
    
    try:
        # Load from extracted files or zip directly? 
        # Using extracted directory since download_gtfs extracts it now.
        
        # 1. Parse Routes (Metadata)
        routes = {}
        with open(os.path.join(GTFS_DIR, 'routes.txt'), 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                routes[row['route_id']] = {
                    'id': row['route_id'],
                    'short_name': row['route_short_name'],
                    'long_name': row['route_long_name'],
                    'color': f"#{row['route_color']}" if row['route_color'] else "#000000",
                    'text_color': f"#{row['route_text_color']}" if row['route_text_color'] else "#FFFFFF"
                }
        subway_data['routes'] = routes

        # 2. Parse Shapes (Geometry)
        raw_shapes = {}
        with open(os.path.join(GTFS_DIR, 'shapes.txt'), 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                sid = row['shape_id']
                if sid not in raw_shapes: raw_shapes[sid] = []
                raw_shapes[sid].append({
                    'lat': float(row['shape_pt_lat']),
                    'lon': float(row['shape_pt_lon']),
                    'seq': int(row['shape_pt_sequence'])
                })
        
        for sid in raw_shapes:
            raw_shapes[sid].sort(key=lambda x: x['seq'])

        # 3. Associate Shapes with Routes
        shape_to_route = {}
        with open(os.path.join(GTFS_DIR, 'trips.txt'), 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row['shape_id']:
                    shape_to_route[row['shape_id']] = row['route_id']

        # 4. Generate GeoJSON
        features = []
        for sid, points in raw_shapes.items():
            coords = [[p['lon'], p['lat']] for p in points]
            route_id = shape_to_route.get(sid, 'Unassigned')
            route_info = routes.get(route_id, {})
            
            feature = {
                "type": "Feature",
                "properties": {
                    "shape_id": sid,
                    "route_id": route_id,
                    "route_short_name": route_info.get('short_name', '?'),
                    "color": route_info.get('color', '#888888')
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords
                }
            }
            features.append(feature)

        subway_data['shapes'] = {
            "type": "FeatureCollection",
            "features": features
        }
        
        print(f"Processed {len(features)} track segments.")
        
        with open(CONFIG_FILE, 'w') as f:
            json.dump(subway_data, f)
        print(f"Saved map config to {CONFIG_FILE}")

    except Exception as e:
        print(f"Error processing map data: {e}")
        raise

def parse_time(t_str):
    """Converts HH:MM:SS to seconds from midnight."""
    h, m, s = map(int, t_str.split(':'))
    return h * 3600 + m * 60 + s

def process_schedule_data():
    """Generates subway_schedule.json (Stop Times)"""
    print(f"Processing Schedule Data (Service: {SERVICE_ID})...")
    
    trips = {} # trip_id -> { route_id, direction, stops: [] }
    
    # 1. Get relevant trips
    with open(os.path.join(GTFS_DIR, 'trips.txt'), 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['service_id'] == SERVICE_ID:
                trips[row['trip_id']] = {
                    "route": row['route_id'],
                    "dir": row['direction_id'],
                    "stops": []
                }
    
    print(f"Found {len(trips)} trips for {SERVICE_ID}.")

    # 2. Get stop times
    print("Loading stop times (this might take a moment)...")
    with open(os.path.join(GTFS_DIR, 'stop_times.txt'), 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            tid = row['trip_id']
            if tid in trips:
                trips[tid]['stops'].append({
                    "id": row['stop_id'],
                    "time": parse_time(row['arrival_time'])
                })

    # 3. Load Stop Coordinates
    print("Loading stop coordinates...")
    stops_loc = {}
    with open(os.path.join(GTFS_DIR, 'stops.txt'), 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                # Store [lat, lon, name]
                stops_loc[row['stop_id']] = [
                    float(row['stop_lat']), 
                    float(row['stop_lon']),
                    row['stop_name']
                ]
            except ValueError:
                pass

    # 4. Organize by Route and Sort stops
    print("Organizing...")
    routes = defaultdict(list)
    for tid, info in trips.items():
        # Sort stops by sequence (using time as proxy since they are sequential)
        info['stops'].sort(key=lambda x: x['time'])
        
        if not info['stops']:
            continue

        routes[info['route']].append({
            "tripId": tid,
            "dir": info['dir'],
            "stops": info['stops']
        })

    # 5. Sort trips within routes by start time for easier searching
    for rid in routes:
        routes[rid].sort(key=lambda t: t['stops'][0]['time'])

    # 6. Save
    print(f"Saving schedule to {SCHEDULE_FILE}...")
    output_data = {
        "routes": routes,
        "stops": stops_loc
    }
    with open(SCHEDULE_FILE, 'w') as f:
        json.dump(output_data, f)
    
    print("Done!")

def main():
    parser = argparse.ArgumentParser(description="Update NYC Subway Data")
    parser.add_argument("--force", action="store_true", help="Force re-download of GTFS data")
    parser.add_argument("--skip-download", action="store_true", help="Skip download, process existing data only")
    parser.add_argument("--map-only", action="store_true", help="Only process map geometry (routes/shapes)")
    parser.add_argument("--schedule-only", action="store_true", help="Only process schedule (timetables)")
    args = parser.parse_args()

    # Default to running both if no specific flag is set
    run_all = not (args.map_only or args.schedule_only)

    if not args.skip_download:
        download_gtfs(force=args.force)
    
    if run_all or args.map_only:
        process_map_data()
        
    if run_all or args.schedule_only:
        process_schedule_data()

if __name__ == "__main__":
    main()
