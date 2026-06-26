#!/bin/bash
# ============================================================
# Cloudflare Tunnel Setup for WhatsApp CRM
# This gives you HTTPS + custom domain for FREE (no SSL cert hassle)
# 
# Prerequisites:
#   - A Cloudflare account (free)
#   - Your domain added to Cloudflare (use their nameservers)
# ============================================================

set -e

echo "=========================================="
echo "  Cloudflare Tunnel Setup"
echo "=========================================="

# Install cloudflared
echo "[1/4] Installing cloudflared..."
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
rm cloudflared.deb

# Login to Cloudflare (opens browser or gives URL)
echo "[2/4] Authenticating with Cloudflare..."
echo "This will open a URL - login and select your domain."
cloudflared tunnel login

# Create tunnel
echo ""
echo "Enter a name for your tunnel (e.g., whatsapp-crm):"
read TUNNEL_NAME
cloudflared tunnel create $TUNNEL_NAME

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep $TUNNEL_NAME | awk '{print $1}')
echo "Tunnel created with ID: $TUNNEL_ID"

# Create config
echo "[3/4] Creating tunnel configuration..."
mkdir -p /home/ubuntu/.cloudflared

echo ""
echo "Enter your domain (e.g., crm.yourdomain.com):"
read DOMAIN_NAME

cat > /home/ubuntu/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: /home/ubuntu/.cloudflared/$TUNNEL_ID.json

ingress:
  # Route all traffic to Nginx (which handles API + static files)
  - hostname: $DOMAIN_NAME
    service: http://localhost:80
  # Catch-all (required)
  - service: http_status:404
EOF

# Create DNS record
echo "[4/4] Creating DNS record..."
cloudflared tunnel route dns $TUNNEL_NAME $DOMAIN_NAME

# Install as systemd service
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared

echo ""
echo "=========================================="
echo "  ✅ Tunnel setup complete!"
echo "=========================================="
echo ""
echo "Your app is now accessible at: https://$DOMAIN_NAME"
echo ""
echo "Useful commands:"
echo "  Check status:  systemctl status cloudflared"
echo "  View logs:     journalctl -u cloudflared -f"
echo "  Restart:       systemctl restart cloudflared"
echo ""
