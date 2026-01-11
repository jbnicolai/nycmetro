import json
import os

def round_coords(coords, precision=5):
    """
    Recursively round coordinates to the specified precision.
    Handles Point, LineString, Polygon, MultiPolygon, etc.
    """
    if isinstance(coords, float):
        return round(coords, precision)
    elif isinstance(coords, int):
        return coords
    elif isinstance(coords, list):
        return [round_coords(c, precision) for c in coords]
    return coords

def optimize_file(filepath):
    print(f"Optimizing {filepath}...")
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        initial_size = os.path.getsize(filepath)
        
        if 'features' in data:
            for feature in data['features']:
                # 1. Strip Properties
                props = feature.get('properties', {})
                if 'description' in props:
                    del props['description']
                
                # Ensure name exists (fallback if needed, though usually present)
                # (Optional: Clean up other unused props like 'url', 'line', etc if we confirm unused)
                
                feature['properties'] = props

                # 2. Round Coordinates
                if 'geometry' in feature and feature['geometry']:
                    feature['geometry']['coordinates'] = round_coords(feature['geometry']['coordinates'])

        with open(filepath, 'w') as f:
            json.dump(data, f, separators=(',', ':')) # Minify whitespace

        final_size = os.path.getsize(filepath)
        reduction = (1 - (final_size / initial_size)) * 100
        print(f"  Done. Size: {initial_size/1024:.1f}KB -> {final_size/1024:.1f}KB (-{reduction:.1f}%)")

    except Exception as e:
        print(f"  Error optimizing {filepath}: {e}")

if __name__ == "__main__":
    files = [
        "data/nyc-neighborhoods.geojson",
        "data/subway-stations.geojson"
    ]
    
    for f in files:
        if os.path.exists(f):
            optimize_file(f)
        else:
            print(f"File not found: {f}")
