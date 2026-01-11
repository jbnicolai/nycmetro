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

def optimize_json(filepath):
    print(f"Optimizing {filepath}...")
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        initial_size = os.path.getsize(filepath)
        
        # Optimize Features (GeoJSON or Config structure)
        features = []
        if 'features' in data:
            features = data['features']
        elif 'shapes' in data and 'features' in data['shapes']:
            features = data['shapes']['features']

        for feature in features:
            # 1. Strip Properties (But extract useful data first)
            props = feature.get('properties', {})
            desc = props.get('description', '')
            
            if desc:
                import re
                # Extract Name
                name_match = re.search(r'<span class="atr-name">NAME</span>:</strong> <span class="atr-value">([^<]+)</span>', desc)
                if name_match:
                    props['name'] = name_match.group(1).strip()
                
                # Extract Line
                line_match = re.search(r'<span class="atr-name">LINE</span>:</strong> <span class="atr-value">([^<]+)</span>', desc)
                if line_match:
                    props['lines'] = line_match.group(1).strip()
            
            if 'description' in props:
                del props['description']
            
            # Clean up other typically unused Socrata fields
            for key in ['url', 'objectid', 'geo_id_ir', 'geometry_name']:
                if key in props:
                    del props[key]

            feature['properties'] = props

            # 2. Round Coordinates
            if 'geometry' in feature and feature['geometry']:
                feature['geometry']['coordinates'] = round_coords(feature['geometry']['coordinates'], 5)

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
        "data/subway-stations.geojson",
        "data/subway_config.json"
    ]
    
    for f in files:
        if os.path.exists(f):
            optimize_json(f)
        else:
            print(f"File not found: {f}")
