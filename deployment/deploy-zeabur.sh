#!/bin/bash
# ============================================================
# WhatsApp CRM - Full Deployment Script for Zeabur/Tencent Server
# Paste this entire script into the SSH web terminal
# ============================================================

set -e

echo "=========================================="
echo "  WhatsApp CRM - Deploying to veloai.pro"
echo "=========================================="

# Update system
echo "[1/9] Updating system..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
echo "[2/9] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Chromium dependencies for whatsapp-web.js
echo "[3/9] Installing Chromium & dependencies..."
sudo apt install -y \
  chromium-browser \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  wget \
  git \
  nginx \
  ca-certificates

# Install PM2
echo "[4/9] Installing PM2..."
sudo npm install -g pm2

# Clone the repo
echo "[5/9] Cloning WhatsApp CRM..."
cd /home/ubuntu
rm -rf whatsapp-crm
git clone https://github.com/hasithasathsara13-ship-it/Whatsapp-CRM.git whatsapp-crm
cd whatsapp-crm

# Install dependencies
echo "[6/9] Installing dependencies..."
cd server && npm install --production && cd ..
cd client && npm install && cd ..

# Build React client for production
echo "[7/9] Building client..."
cd client && npm run build && cd ..

# Setup Nginx
echo "[8/9] Configuring Nginx..."
sudo tee /etc/nginx/sites-available/whatsapp-crm > /dev/null << 'NGINX'
server {
    listen 80;
    server_name veloai.pro;

    root /home/ubuntu/whatsapp-crm/client/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINX

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/whatsapp-crm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Start the server with PM2
echo "[9/9] Starting server with PM2..."
cd /home/ubuntu/whatsapp-crm
pm2 start server/index.js --name whatsapp-crm
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo ""
echo "=========================================="
echo "  ✅ DEPLOYMENT COMPLETE!"
echo "=========================================="
echo ""
echo "  Server running at: http://43.156.68.153"
echo "  Next: Setup Cloudflare Tunnel for HTTPS"
echo ""
