#!/bin/bash
# ============================================================
# Quick Deploy / Update Script
# Run this whenever you push new code to update the production app
# Usage: chmod +x deploy.sh && ./deploy.sh
# ============================================================

set -e

APP_DIR="/home/ubuntu/whatsapp-crm"

echo "🚀 Deploying WhatsApp CRM..."

cd $APP_DIR

# Pull latest code
echo "[1/5] Pulling latest code..."
git pull origin main

# Install dependencies (in case new ones were added)
echo "[2/5] Installing dependencies..."
cd server && npm install --production && cd ..
cd client && npm install && cd ..

# Build React client
echo "[3/5] Building client..."
cd client && npm run build && cd ..

# Restart server with PM2
echo "[4/5] Restarting server..."
pm2 restart whatsapp-crm-server

# Check status
echo "[5/5] Checking status..."
sleep 2
pm2 status

echo ""
echo "✅ Deployment complete!"
echo "   Check logs: pm2 logs whatsapp-crm-server"
echo ""
