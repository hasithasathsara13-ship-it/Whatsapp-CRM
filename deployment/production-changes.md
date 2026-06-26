# Production Changes Needed Before Deploying

## 1. Update Client Socket URL (client/src/App.jsx)

Change line 6 from:
```js
const socket = io('http://localhost:8790');
```
To:
```js
const socket = io(window.location.origin);
```

## 2. Update All fetch() URLs in client/src/App.jsx

Replace all instances of `http://localhost:8790` with empty string (relative URLs):
- `http://localhost:8790/api/contacts/load` → `/api/contacts/load`
- `http://localhost:8790/api/contacts/save` → `/api/contacts/save`
- `http://localhost:8790/api/contacts/update-label` → `/api/contacts/update-label`
- `http://localhost:8790/api/contacts/delete` → `/api/contacts/delete`
- `http://localhost:8790/api/auth/login` → `/api/auth/login`
- `http://localhost:8790/api/auth/verify` → `/api/auth/verify`
- `http://localhost:8790/api/bot-contacts` → `/api/bot-contacts`
- `http://localhost:8790/api/labels/save` → `/api/labels/save`
- `http://localhost:8790/api/labels/load` → `/api/labels/load`

## 3. Build the Client
```bash
cd client && npm run build
```

## 4. The Nginx config serves the built files from client/dist

---

## Oracle Cloud Setup Steps (in order):

1. Create an Oracle Cloud account (free tier)
2. Launch an ARM instance (Ampere A1 - 4 OCPU, 24GB RAM)
   - Image: Ubuntu 22.04 or 24.04
   - Download your SSH key during creation
3. Add ingress rules in Security List:
   - Port 80 (HTTP)
   - Port 443 (HTTPS)
4. SSH in: `ssh -i your-key.pem ubuntu@<public-ip>`
5. Run: `sudo ./setup-server.sh`
6. Clone repo and install deps
7. Apply production changes above
8. Build client: `npm run build-client`
9. Copy ecosystem.config.js to app root
10. Start: `pm2 start ecosystem.config.js && pm2 save`
11. Configure Nginx: copy nginx.conf, update domain, enable site
12. Run: `./deploy-tunnel.sh` for Cloudflare Tunnel + HTTPS
13. Done! Your app is live at https://yourdomain.com
