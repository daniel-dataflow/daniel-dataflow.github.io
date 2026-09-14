#!/bin/sh

# ==============================================================================
# Tech Blog & Admin CMS Local Development Runner
# Usage: sh scripts/run.sh  (or ./scripts/run.sh)
# ==============================================================================

# Get absolute path of script directory and project root
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

PORT=${PORT:-"1313"}
HOST=${HOST:-"127.0.0.1"}

echo "=================================================="
echo "  Tech Blog & Admin CMS Local Server"
echo "  Project Root: $PROJECT_ROOT"
echo "=================================================="

# Check if port 1313 is already in use and clean up stale instance
EXISTING_PID=$(lsof -ti :"$PORT" 2>/dev/null)
if [ -n "$EXISTING_PID" ]; then
    echo "[INFO] Port $PORT is already in use by PID $EXISTING_PID. Cleaning up..."
    kill -15 $EXISTING_PID 2>/dev/null || kill -9 $EXISTING_PID 2>/dev/null
    sleep 1
fi

# Detect Hugo or fallback to Python 3 static server
if command -v hugo >/dev/null 2>&1; then
    echo "[INFO] Hugo binary detected. Starting Hugo development server..."
    echo ""
    echo "=================================================="
    echo "  🚀 Local Server is running!"
    echo "  - Blog Home : http://localhost:$PORT/"
    echo "  - Admin CMS : http://localhost:$PORT/admin/"
    echo "=================================================="
    echo ""
    cd "$PROJECT_ROOT" && hugo server -D --port "$PORT" --bind "$HOST"
else
    echo "[INFO] Hugo not found. Falling back to Python 3 HTTP server..."
    echo "[INFO] Serving static directory: $PROJECT_ROOT/static"
    echo ""
    echo "=================================================="
    echo "  🚀 Local Admin Server is running!"
    echo "  👉 Admin CMS : http://localhost:$PORT/admin/"
    echo "=================================================="
    echo ""
    cd "$PROJECT_ROOT" && python3 -m http.server "$PORT" --bind "$HOST" --directory "$PROJECT_ROOT/static"
fi
