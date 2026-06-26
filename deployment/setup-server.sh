#!/bin/bash
# ============================================================
# Oracle Cloud VPS Setup Script for WhatsApp CRM
# Run this after SSH-ing into your new Oracle Cloud instance
# Usage: chmod +x setup-server.sh && sudo ./setup-server.sh
# ============================================================

set -e

echo "=========================================="
echo "  WhatsApp CRM - Server Setup"
echo "=========================================="

# Update system
echo "[1/8] Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20 LTS
echo "[2/8] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install Chromium dependencies (needed for whatsapp-web.js & Puppeteer)
echo "[3/8] Installing Chromium dependencies..."
apt install -y \
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
  ca-certificates

# Install PM2 globally
echo "[4/8] Installing PM2..."
npm install -g pm2

# Install Nginx
echo "[5/8] Installing Nginx..."
apt install -y nginx

# Create app directory
echo "[6/8] Setting up application directory..."
mkdir -p /home/ubuntu/whatsapp-crm/logs
chown -R ubuntu:ubuntu /home/ubuntu/whatsapp-crm

# Configure firewall (Oracle Cloud uses iptables)
echo "[7/8] Configuring firewall..."
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8790 -j ACCEPT
netfilter-persistent save

# Setup PM2 to start on boot
echo "[8/8] Configuring PM2 startup..."
pm2 startup systemd -u ubuntu --hp /home/ubuntu
env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo ""
echo "=========================================="
echo "  ✅ Server setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Switch to ubuntu user: su - ubuntu"
echo "  2. Clone your repo: git clone <your-repo-url> /home/ubuntu/whatsapp-crm"
echo "  3. Install deps: cd /home/ubuntu/whatsapp-crm && npm run install-all"
echo "  4. Build client: npm run build-client"
echo "  5. Start with PM2: pm2 start ecosystem.config.js"
echo "  6. Save PM2 state: pm2 save"
echo "  7. Setup Cloudflare Tunnel (see deploy-tunnel.sh)"
echo ""
