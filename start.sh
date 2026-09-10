#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Installing backend dependencies ==="
cd backend
npm install --production=false
echo ""

echo "=== Building backend ==="
npm run build
echo ""

echo "=== Installing frontend dependencies ==="
cd ../frontend
npm install
echo ""

echo "=== Building frontend ==="
npx vite build
echo ""

echo "=== Starting server ==="
cd ../backend
exec node dist/index.js
