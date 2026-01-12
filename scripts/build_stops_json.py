import csv
import json
import os
import sys

INPUT_FILE = os.path.join(os.path.dirname(__file__), '../data/gtfs/stops.txt')
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), '../data/stops_coords.json')

def build_stops_json():
    print(f"Reading stops from {INPUT_FILE}...")
    
    if not os.path.exists(INPUT_FILE):
        print(f"Error: {INPUT_FILE} not found.")
        sys.exit(1)

    stops = {}
    count = 0

    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            stop_id = row['stop_id']
            try:
                lat = float(row['stop_lat'])
                lon = float(row['stop_lon'])
                # Round to 6 decimals
                stops[stop_id] = [round(lat, 6), round(lon, 6)]
                count += 1
            except ValueError:
                continue

    print(f"Parsed {count} stops.")
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(stops, f, separators=(',', ':'))
    
    print(f"Wrote {OUTPUT_FILE} ({os.path.getsize(OUTPUT_FILE)} bytes).")

if __name__ == '__main__':
    build_stops_json()
