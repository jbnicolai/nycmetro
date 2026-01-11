import http.server
import socketserver
import json
import os
import random
import gzip
from urllib.parse import urlparse
import datetime
import requests
from google.transit import gtfs_realtime_pb2
import time
import threading
from threading import Lock
from concurrent.futures import ThreadPoolExecutor

PORT = int(os.environ.get('PORT', 8001))
DATA_FILE = "data/subway_config.json"
SCHEDULE_FILE = "data/subway_schedule.json"
ENV = os.environ.get('ENV', 'development')

MTA_ALERTS_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeed_id=c"
ALERTS_CACHE = {
    "data": [],
    "last_updated": 0
}

def fetch_alerts_feed():
    """Fetches the MTA GTFS-Realtime Alerts Feed once."""
    global ALERTS_CACHE
    try:
        print("[Alerts] Fetching feed...", flush=True)
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        resp = requests.get(MTA_ALERTS_URL, headers=headers, timeout=10)
        
        if resp.status_code == 200:
            feed = gtfs_realtime_pb2.FeedMessage()
            feed.ParseFromString(resp.content)
            
            new_alerts = []
            for entity in feed.entity:
                if entity.HasField('alert'):
                    alert = entity.alert
                    
                    # Extract text (english)
                    header_text = "Alert"
                    if alert.header_text.translation:
                        header_text = alert.header_text.translation[0].text
                    
                    description_text = ""
                    if alert.description_text.translation:
                        description_text = alert.description_text.translation[0].text

                    # Extract affected entities (routes)
                    affected_routes = []
                    for sel in alert.informed_entity:
                        if sel.route_id:
                            affected_routes.append(sel.route_id)
                    
                    new_alerts.append({
                        "id": entity.id,
                        "header": header_text,
                        "description": description_text,
                        "routes": list(set(affected_routes)) # Dedupe
                    })
            
            return new_alerts
        else:
            print(f"[Alerts] Fetch failed: {resp.status_code}", flush=True)
            
    except Exception as e:
        print(f"[Alerts] Error fetching feed: {e}", flush=True)
    
    return None

def fetch_realtime_feed():
    """Fetches and parses GTFS-RT feed from MTA in parallel."""
    FEED_URLS = [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",      # 1-7
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",  # A/C/E
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw", # N/Q/R/W
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm", # B/D/F/M
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",    # L
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g"     # G
    ]
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36"
    }
    
    trips = []
    collected_alerts = []
    
    def fetch_one(url):
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code == 200:
                return resp.content
        except Exception as e:
            print(f"Error fetching feed {url}: {e}")
        return None

    # Fetch all in parallel
    print(f"Fetching {len(FEED_URLS)} feeds in parallel...", flush=True)
    with ThreadPoolExecutor(max_workers=len(FEED_URLS)) as executor:
        contents = list(executor.map(fetch_one, FEED_URLS))

    success_count = sum(1 for c in contents if c)
    print(f"Fetched {success_count} feeds successfully.", flush=True)

    for url, content in zip(FEED_URLS, contents):
        if not content: continue
        
        try:
            feed = gtfs_realtime_pb2.FeedMessage()
            feed.ParseFromString(content)
            
            # Use global to limit log spam
            global logged_count_per_feed
            if 'logged_count_per_feed' not in globals(): logged_count_per_feed = {}
            feed_name = url.split('%2F')[-1]
            if feed_name not in logged_count_per_feed: logged_count_per_feed[feed_name] = 0

            # Process Updates
            for entity in feed.entity:
                if entity.HasField('alert'):
                    alert = entity.alert
                    header_text = alert.header_text.translation[0].text if alert.header_text.translation else "Alert"
                    desc_text = alert.description_text.translation[0].text if alert.description_text.translation else ""
                    affected_routes = [sel.route_id for sel in alert.informed_entity if sel.route_id]
                    
                    collected_alerts.append({
                        "id": entity.id,
                        "header": header_text,
                        "description": desc_text,
                        "routes": list(set(affected_routes))
                    })

                if entity.HasField('trip_update'):
                    tu = entity.trip_update
                    if tu.stop_time_update:
                        stu = tu.stop_time_update[0]
                        trips.append({
                            "tripId": tu.trip.trip_id,
                            "routeId": tu.trip.route_id,
                            "stopId": stu.stop_id,
                            "status": "STOPPED_AT" if not stu.arrival.time else "IN_TRANSIT_TO",
                            "time": stu.arrival.time or stu.departure.time
                        })
        except Exception as e:
            print(f"Error parsing feed content: {e}", flush=True)

    print(f"Processed {len(trips)} RT trips and {len(collected_alerts)} alerts.", flush=True)
    
    # Update Global Alerts Cache
    # Note: We might get duplicate alerts from the main RT feed, so we merge or just rely on the dedicated feed.
    # For now, let's NOT overwrite the dedicated alerts cache from here to avoid race conditions or format mismatches.
    # If we wanted to merge, we'd need to normalize fully.
    # with alerts_lock:
    #    ALERTS_CACHE['data'] = collected_alerts
            
    return trips

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS
        self.send_header('Access-Control-Allow-Origin', '*')
        
        # Caching Strategy
        # Check if Cache-Control was already set in the handler
        has_cache_control = any(h for h in self._headers_buffer if b'Cache-Control' in h)

        if not has_cache_control:
            if ENV == 'production':
                # Cache static assets for 1 hour, but require revalidation for API
                if self.path.startswith('/api/'):
                    self.send_header('Cache-Control', 'no-cache')
                else:
                    self.send_header('Cache-Control', 'public, max-age=3600')
            else:
                # Disable Caching by default (Development Mode)
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.send_header('Pragma', 'no-cache')
                self.send_header('Expires', '0')
            
        super().end_headers()

    def do_GET(self):
        # Parse path to ignore query params
        parsed_url = urlparse(self.path)
        parsed_path = parsed_url.path
        
        # Only print in dev or if explicitly requested to avoid log spam
        if ENV == 'development' or os.environ.get('DEBUG'):
             print(f"Handling GET: {self.path} -> {parsed_path}")

        if parsed_path == '/api/config':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, 'rb') as f:
                    content = f.read()

                # Gzip Compression
                if 'gzip' in self.headers.get('Accept-Encoding', ''):
                    content = gzip.compress(content)
                    self.send_header('Content-Encoding', 'gzip')

                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            else:
                self.end_headers()
                self.wfile.write(b'{"error": "Data not found. Run scripts/update_data.py first."}')
        
        elif parsed_path == '/api/schedule':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            
            if SCHEDULE_CACHE:
                # Calculate time window using NYC time
                try:
                    from zoneinfo import ZoneInfo
                    tz = ZoneInfo("America/New_York")
                except ImportError:
                    # Fallback for older python (though 3.11 is used)
                    # Simple offset for EST/EDT (imperfect but better than UTC)
                    tz = datetime.timezone(datetime.timedelta(hours=-4))
                
                now = datetime.datetime.now(tz)
                # Midnight for today in NYC
                midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
                seconds_since_midnight = (now - midnight).total_seconds()
                
                # Window logic
                start_window = seconds_since_midnight - 600 # 10 mins buffer
                end_window = seconds_since_midnight + (2 * 3600) # 2 hours ahead

                # Handle wraparound for late night (if near 24h, schedule might go > 86400)
                # For simplicity, we just filter. Ideally we handle day overlap.
                
                # Determine Service ID based on NYC Time
                dow = now.weekday() # 0=Mon, 5=Sat, 6=Sun
                if dow == 5:
                    target_service = "Saturday"
                elif dow == 6:
                    target_service = "Sunday"
                else:
                    target_service = "Weekday"
                
                print(f"Loading Schedule for {target_service} (DOW: {dow})", flush=True)

                filtered_routes = {}
                active_trips_count = 0
                
                # Filter Routes
                for route_id, trips in SCHEDULE_CACHE.get('routes', {}).items():
                    filtered_trips = []
                    for trip in trips:
                        # Check Service ID
                        if trip.get('serviceId') != target_service:
                            continue

                        stops = trip.get('stops', [])
                        if not stops: continue
                        
                        start_time = stops[0]['time']
                        end_time = stops[-1]['time']
                        
                        # Check overlap: Trip starts before window ends AND trip ends after window starts
                        if start_time <= end_window and end_time >= start_window:
                            filtered_trips.append(trip)
                    
                    if filtered_trips:
                        filtered_routes[route_id] = filtered_trips
                        active_trips_count += len(filtered_trips)
                
                print(f"Server returning {active_trips_count} trips.", flush=True)
                
                response_data = {
                    'routes': filtered_routes,
                    'stops': SCHEDULE_CACHE.get('stops', {}),
                    'meta': {
                        'window_start': start_window,
                        'window_end': end_window,
                        'total_trips': active_trips_count
                    }
                }
                
                content = json.dumps(response_data).encode('utf-8')

                # Gzip Compression
                if 'gzip' in self.headers.get('Accept-Encoding', ''):
                    content = gzip.compress(content)
                    self.send_header('Content-Encoding', 'gzip')

                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            else:
                 self.send_response(500)
                 self.end_headers()
                 self.wfile.write(b'{"error": "Schedule not loaded"}')

        elif parsed_path == '/api/realtime':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            
            # Simple Caching (30s)
            now_ts = datetime.datetime.now().timestamp()
            
            # Check Config - permissive (try without key)
            # if not MTA_API_KEY: ... (Removed to allow keyless access)

            with RT_LOCK:
                if not RT_CACHE['data'] or (now_ts - RT_CACHE['last_updated'] > 30):
                    print(f"Refreshing Realtime Data... (Cached: {bool(RT_CACHE['data'])}, Age: {now_ts - RT_CACHE['last_updated']:.1f}s)", flush=True)
                    try:
                        new_data = fetch_realtime_feed()
                        # Only update if we got *some* data (simple safety)
                        if new_data: 
                            RT_CACHE['data'] = new_data
                            RT_CACHE['last_updated'] = now_ts
                    except Exception as e:
                        print(f"Global RT Fetch Error: {e}", flush=True)
            
            response_data = {
                "updated": RT_CACHE['last_updated'],
                "trips": RT_CACHE['data'] or []
            }
            
            content = json.dumps(response_data).encode('utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            
        elif self.path == '/api/alerts':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            # On-Demand Caching Strategy (60s TTL)
            now_ts = datetime.datetime.now().timestamp()
            
            # Simple permissive lock check (not strictly double-checked locking but fine for this scale)
            # If multiple requests come in, worst case we fetch twice.
            need_fetch = False
            with alerts_lock:
                 if not ALERTS_CACHE['data'] or (now_ts - ALERTS_CACHE['last_updated'] > 60):
                     need_fetch = True
            
            if need_fetch:
                new_alerts = fetch_alerts_feed()
                if new_alerts is not None:
                    with alerts_lock:
                        ALERTS_CACHE['data'] = new_alerts
                        ALERTS_CACHE['last_updated'] = now_ts
            
            with alerts_lock:
                data = json.dumps(ALERTS_CACHE['data'])
                
            self.wfile.write(data.encode('utf-8'))
            
        else:
            # Fallback to serving static files, but with Gzip support for JSON
            if parsed_path.endswith('.json') or parsed_path.endswith('.geojson'):
                # Try to find the file
                file_path = parsed_path.lstrip('/')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    
                    with open(file_path, 'rb') as f:
                        content = f.read()
                    
                    if 'gzip' in self.headers.get('Accept-Encoding', ''):
                        content = gzip.compress(content)
                        self.send_header('Content-Encoding', 'gzip')
                    
                    self.send_header('Content-Length', str(len(content)))
                    self.send_header('Cache-Control', 'public, max-age=3600') # Cache for 1 hour
                    self.end_headers()
                    self.wfile.write(content)
                    return
            
            return http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self.path == '/api/log':
            # Only allow writing logs if DEBUG env var is set OR we are in development
            if ENV != 'development' and not os.environ.get('DEBUG'):
                self.send_response(403)
                self.end_headers()
                return

            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                log_entry = json.loads(post_data.decode('utf-8'))
                with open("frontend_debug.log", "a") as f:
                    f.write(f"[{log_entry.get('level', 'INFO')}] {log_entry.get('message')}\n")
                    f.flush() 
                
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status": "ok"}')
            except Exception as e:
                print(f"Log error: {e}")
                self.send_response(500)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

class ReuseAddrTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == "__main__":
    print(f"Server starting on port {PORT} in {ENV} mode...")
    
    # Load Schedule
    try:
        with open(SCHEDULE_FILE, 'r') as f:
            SCHEDULE_CACHE = json.load(f)
        
        print("Normalizing Trip IDs...")
        count = 0
        for rid, trips in SCHEDULE_CACHE.get('routes', {}).items():
            for trip in trips:
                original = trip.get('tripId', "")
                parts = original.split('_')
                if len(parts) >= 2:
                    trip['tripId'] = "_".join(parts[-2:])
                    count += 1
        print(f"Schedule loaded and normalized {count} IDs successfully.")

    except Exception as e:
        print(f"Failed to load schedule: {e}")

    # Start Realtime Thread (Poller for Trips)
    # We disable daemon mode so it doesn't just die instantly if main exits (but typical httpd.serve_forever keeps it alive)
    # rt_thread = threading.Thread(target=fetch_realtime_feed, daemon=True)
    # rt_thread.start()

    # Alert Thread Removed (Now On-Demand via /api/alerts)

    try:
        with ReuseAddrTCPServer(("", PORT), MyHandler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        pass
