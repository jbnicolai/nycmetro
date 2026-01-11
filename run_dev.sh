#!/bin/bash
# run_dev.sh - Helper to run the server in a virtual environment

# 1. Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# 2. Install dependencies
echo "Installing/Updating dependencies..."
./venv/bin/pip install -r requirements.txt

# 3. Run Server
echo "Starting Server on Port 8001..."
export PORT=8001
export ENV=development
export DEBUG=true

./venv/bin/python3 server.py
