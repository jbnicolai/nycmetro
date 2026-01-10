import http.server
import socketserver
import json
import os
from urllib.parse import urlparse

PORT = int(os.environ.get('PORT', 8001))
DATA_FILE = "data/subway_config.json"
ENV = os.environ.get('ENV', 'development')

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
        parsed_path = urlparse(self.path).path
        # Only print in dev or if explicitly requested to avoid log spam
        if ENV == 'development' or os.environ.get('DEBUG'):
             print(f"Handling GET: {self.path} -> {parsed_path}")

        if parsed_path == '/api/config':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.wfile.write(b'{"error": "Data not found. Run scripts/update_data.py first."}')
        
        elif parsed_path == '/api/schedule':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            schedule_file = "data/subway_schedule.json"
            if os.path.exists(schedule_file):
                with open(schedule_file, 'rb') as f:
                    self.wfile.write(f.read())
        else:
            return http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self.path == '/api/log':
            # Only allow writing logs if DEBUG env var is set
            if not os.environ.get('DEBUG'):
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
