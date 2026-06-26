#!/bin/bash
# ============================================================
# Xvfb + VNC + noVNC setup for live browser streaming
# Lets users see and solve CAPTCHAs in the scraper via veloai.pro/vnc/
# ============================================================
set -e

echo "[1/5] Installing Xvfb, x11vnc, noVNC, fluxbox..."
sudo apt update
sudo apt install -y xvfb x11vnc novnc websockify fluxbox

# Create systemd service for Xvfb (virtual display :99)
echo "[2/5] Creating Xvfb service..."
sudo tee /etc/systemd/system/xvfb.service > /dev/null << 'EOF'
[Unit]
Description=Xvfb Virtual Display
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

# Fluxbox window manager on display :99 (so browser windows render properly)
echo "[3/5] Creating Fluxbox service..."
sudo tee /etc/systemd/system/fluxbox.service > /dev/null << 'EOF'
[Unit]
Description=Fluxbox Window Manager
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=:99
ExecStart=/usr/bin/fluxbox
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

# x11vnc - shares display :99 over VNC (localhost only, noVNC bridges it)
echo "[4/5] Creating x11vnc service..."
sudo tee /etc/systemd/system/x11vnc.service > /dev/null << 'EOF'
[Unit]
Description=x11vnc server
After=fluxbox.service
Requires=fluxbox.service

[Service]
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -localhost
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

# noVNC - web-based VNC client, bridges websocket to VNC on 5900, serves on 6080
echo "[5/5] Creating noVNC service..."
sudo tee /etc/systemd/system/novnc.service > /dev/null << 'EOF'
[Unit]
Description=noVNC websockify
After=x11vnc.service
Requires=x11vnc.service

[Service]
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable xvfb fluxbox x11vnc novnc
sudo systemctl restart xvfb fluxbox x11vnc novnc

echo ""
echo "=========================================="
echo "  VNC stack running. Display :99 streamed on port 6080"
echo "  noVNC available at localhost:6080/vnc.html"
echo "=========================================="
