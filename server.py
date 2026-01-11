import http.server
import socketserver
import json
import os
import gzip
from urllib.parse import urlparse

import datetime
import time

PORT = int(os.environ.get('PORT', 8001))
DATA_FILE = "data/subway_config.json"
SCHEDULE_FILE = "data/subway_schedule.json"
ENV = os.environ.get('ENV', 'development')

# Load schedule into memory
SCHEDULE_CACHE = None
if os.path.exists(SCHEDULE_FILE):
    print("Loading schedule into memory...")
    try:
        with open(SCHEDULE_FILE, 'r') as f:
            SCHEDULE_CACHE = json.load(f)
        print("Schedule loaded successfully.")
    except Exception as e:
        print(f"Failed to load schedule: {e}")

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS
        self.send_header('Access-Control-Allow-Origin', '*')
        
        # Caching Strategy
        if ENV == 'production':
            # Cache static assets for 1 hour, but require revalidation for API
            if self.path.startswith('/api/'):
                self.send_header('Cache-Control', 'no-cache')
            else:
                self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            # Disable Caching (Development Mode)
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
                # Calculate time window (Now - 10m to Now + 4h)
                now = datetime.datetime.now()
                # Midnight for today
                midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
                seconds_since_midnight = (now - midnight).total_seconds()
                
                # Window logic
                start_window = seconds_since_midnight - 600 # 10 mins buffer
                end_window = seconds_since_midnight + (4 * 3600) # 4 hours ahead

                # Handle wraparound for late night (if near 24h, schedule might go > 86400)
                # For simplicity, we just filter. Ideally we handle day overlap.
                
                filtered_routes = {}
                active_trips_count = 0
                
                # Filter Routes
                for route_id, trips in SCHEDULE_CACHE.get('routes', {}).items():
                    filtered_trips = []
                    for trip in trips:
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
        else:
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
    try:
        with ReuseAddrTCPServer(("", PORT), MyHandler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        pass
