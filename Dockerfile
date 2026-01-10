# Base Image (Small & Secure)
FROM python:3.11-slim

# Working Directory
WORKDIR /app

# Copy Project Files
# We copy explicitly to avoid unwanted files
COPY index.html .
COPY server.py .
COPY src/ ./src/
COPY data/ ./data/
COPY scripts/ ./scripts/

# Ensure data directory exists and has permissions
RUN mkdir -p data/gtfs

# Run generation script to ensure data is fresh/present at build time
# (Optional: if you want to ship pre-built data, remove this and commit the data folder)
RUN python scripts/update_data.py --skip-download || echo "Data update failed, proceeding anyway (assuming data exists)"

# Set Environment Variables
ENV PORT=8001
ENV ENV=production

# Expose the port
EXPOSE $PORT

# Start Command
CMD ["python", "server.py"]
