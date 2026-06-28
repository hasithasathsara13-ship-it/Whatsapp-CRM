const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = 8790;
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8, // 100 MB
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let client = null;
let isConnected = false;
let qrCode = null;
let isInitializing = false;

async function startWhatsApp() {
    if (isInitializing) {
        console.log('WhatsApp is already initializing...');
        return;
    }
    isInitializing = true;

    // --- CLEANUP PREVIOUS CLIENT ---
    if (client) {
        console.log('Cleaning up previous connection...');
        try {
            await client.destroy();
        } catch (e) {
            console.error('Cleanup error:', e.message);
        }
        client = null;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_DIR
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--js-flags="--max-old-space-size=2048"' // Give more memory to browser JS
            ]
        }
    });

    client.on('qr', async (qr) => {
        isConnected = false;
        isInitializing = false;
        qrCode = await qrcode.toDataURL(qr);
        io.emit('qr', { qr: qrCode });
        console.log('New QR code generated');
    });

    client.on('ready', async () => {
        isConnected = true;
        isInitializing = false;
        qrCode = null;
        console.log('✅ WhatsApp Connected!');

        // Increase timeouts for media handling
        try {
            const page = client.pupPage;
            if (page) {
                await page.setDefaultTimeout(60000); 
                await page.setDefaultNavigationTimeout(60000);
            }
        } catch (e) {
            console.error('Timeout setup error:', e.message);
        }

        io.emit('status', { 
            connected: true, 
            user: {
                id: client.info.wid._serialized,
                name: client.info.pushname || 'WhatsApp User'
            } 
        });
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED');
    });

    client.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        io.emit('status', { connected: false, reason: msg });
    });

    client.on('disconnected', (reason) => {
        isConnected = false;
        isInitializing = false;
        qrCode = null;
        console.log('Client was logged out', reason);
        io.emit('status', { connected: false, reason: reason });
        // Attempt to re-initialize for new QR
        setTimeout(startWhatsApp, 2000);
    });

    client.initialize().catch(err => {
        console.error('Initialization error:', err.message);
        isInitializing = false;
    });
}

async function logout() {
    isInitializing = false;
    try {
        if (client) {
            await client.logout();
            await client.destroy();
        }
    } catch (e) {}
    
    // session folder will be handled by wwebjs logout usually, but we force clean
    if (fs.existsSync(SESSION_DIR)) {
        await fs.remove(SESSION_DIR);
    }
    
    client = null;
    isConnected = false;
    qrCode = null;
    io.emit('status', { connected: false });
    console.log('Logged out and auth files deleted.');
    startWhatsApp(); 
}

// Broadcast State
let activeBroadcast = null;

io.on('connection', (socket) => {
    console.log('New client connected');
    
    // Send initial status
    socket.emit('status', { 
        connected: isConnected, 
        user: isConnected && client?.info ? {
            id: client.info.wid._serialized,
            name: client.info.pushname || 'WhatsApp User'
        } : null 
    });
    if (qrCode) {
        socket.emit('qr', { qr: qrCode });
    }

    socket.on('logout', async () => {
        await logout();
    });

    socket.on('start_broadcast', async (data) => {
        const { numbers, message, delay, media, document: doc } = data;
        
        console.log('--- START BROADCAST EVENT RECEIVED ---');
        console.log(`Contacts: ${numbers?.length}, Delay: ${delay?.min}-${delay?.max}s`);

        if (!isConnected || !client) {
            return socket.emit('broadcast_status', { message: '❌ Error: WhatsApp not connected. Please go to "Connect" tab.', done: true });
        }

        if (!numbers || numbers.length === 0) {
            return socket.emit('broadcast_status', { message: '❌ Error: No numbers provided.', done: true });
        }

        // --- ANTI-BAN CONFIGURATION ---
        const ANTI_BAN = {
            MIN_DELAY_SEC: 15,          // Absolute minimum 15s between messages
            MAX_MESSAGES_PER_HOUR: 25,  // Hard cap per hour
            MAX_MESSAGES_PER_DAY: 150,  // Hard cap per day
            BATCH_SIZE: 10,             // After 10 messages, take a long break
            BATCH_BREAK_MIN: 180000,    // 3 min batch break minimum
            BATCH_BREAK_MAX: 420000,    // 7 min batch break maximum
            ACTIVE_HOURS_START: 8,      // Don't send before 8 AM
            ACTIVE_HOURS_END: 21,       // Don't send after 9 PM
        };

        // Enforce minimum delay (user can set higher, but not lower than 15s)
        const userMin = Math.max(parseInt(delay.min) || 15, ANTI_BAN.MIN_DELAY_SEC);
        const userMax = Math.max(parseInt(delay.max) || 45, userMin + 10);

        // Check active hours
        const currentHour = new Date().getHours();
        if (currentHour < ANTI_BAN.ACTIVE_HOURS_START || currentHour >= ANTI_BAN.ACTIVE_HOURS_END) {
            return socket.emit('broadcast_status', { message: `⚠️ Anti-ban protection: Messages can only be sent between ${ANTI_BAN.ACTIVE_HOURS_START}:00 and ${ANTI_BAN.ACTIVE_HOURS_END}:00. Try again during active hours.`, done: true });
        }

        // Cap contacts per session
        const maxForSession = Math.min(numbers.length, ANTI_BAN.MAX_MESSAGES_PER_DAY);
        if (numbers.length > maxForSession) {
            socket.emit('broadcast_status', { message: `⚠️ Capped to ${maxForSession} messages for today (anti-ban). Remaining will need another session.` });
        }

        activeBroadcast = { stopped: false, paused: false, current: 0, total: maxForSession };
        let sentThisHour = 0;
        let sentTotal = 0;

        socket.emit('broadcast_status', { message: `🚀 Campaign started for ${maxForSession} contacts (anti-ban: ${userMin}-${userMax}s delay, batch breaks every ${ANTI_BAN.BATCH_SIZE} msgs).` });
        await new Promise(resolve => setTimeout(resolve, 1000));

        for (let i = 0; i < maxForSession; i++) {
            if (activeBroadcast.stopped) { console.log('Broadcast stopped by user.'); break; }
            
            while (activeBroadcast.paused) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (activeBroadcast.stopped) break;
            }
            if (activeBroadcast.stopped) break;

            // Hourly rate check
            if (sentThisHour >= ANTI_BAN.MAX_MESSAGES_PER_HOUR) {
                socket.emit('broadcast_status', { message: `⏸️ Hourly limit (${ANTI_BAN.MAX_MESSAGES_PER_HOUR}) reached. Pausing for safety... Will auto-resume.` });
                await new Promise(resolve => setTimeout(resolve, 600000)); // 10 min pause
                sentThisHour = 0;
                if (activeBroadcast.stopped) break;
            }

            // Active hours check mid-campaign
            const nowHour = new Date().getHours();
            if (nowHour >= ANTI_BAN.ACTIVE_HOURS_END || nowHour < ANTI_BAN.ACTIVE_HOURS_START) {
                socket.emit('broadcast_status', { message: `🌙 Outside active hours. Campaign paused until tomorrow ${ANTI_BAN.ACTIVE_HOURS_START}:00.`, done: true });
                break;
            }

            const number = numbers[i].replace(/\D/g, '');
            const jid = `${number}@c.us`;
            
            socket.emit('broadcast_status', { message: `⏳ [${i + 1}/${maxForSession}] Sending to ${numbers[i]}...` });

            try {
                if (media && media.data) {
                    const base64Data = media.data.split(",")[1];
                    const msgMedia = new MessageMedia(media.type, base64Data, media.name || 'image');
                    await client.sendMessage(jid, msgMedia, { caption: message });
                } else if (message) {
                    await client.sendMessage(jid, message);
                }

                if (doc && doc.data) {
                    const docBase64 = doc.data.split(",")[1];
                    const docMedia = new MessageMedia(doc.type, docBase64, doc.name);
                    await client.sendMessage(jid, docMedia);
                }
                
                sentThisHour++;
                sentTotal++;
                socket.emit('broadcast_status', { 
                    number: numbers[i], status: 'success', current: i + 1, total: maxForSession,
                    message: `✅ [${i + 1}/${maxForSession}] Delivered to ${numbers[i]}`
                });
            } catch (err) {
                console.error(`Failed for ${numbers[i]}:`, err.message);
                socket.emit('broadcast_status', { 
                    number: numbers[i], status: 'error', current: i + 1, total: maxForSession,
                    message: `❌ [${i + 1}/${maxForSession}] Failed: ${numbers[i]} — ${err.message}`
                });
            }

            // --- ANTI-BAN DELAYS ---
            if (i < maxForSession - 1 && !activeBroadcast.stopped) {
                // Mandatory batch break every N messages
                if (sentTotal > 0 && sentTotal % ANTI_BAN.BATCH_SIZE === 0) {
                    const batchBreak = Math.floor(ANTI_BAN.BATCH_BREAK_MIN + Math.random() * (ANTI_BAN.BATCH_BREAK_MAX - ANTI_BAN.BATCH_BREAK_MIN));
                    socket.emit('broadcast_status', { message: `☕ Batch of ${ANTI_BAN.BATCH_SIZE} done. Safety break for ${Math.round(batchBreak / 60000)} min...` });
                    await new Promise(resolve => setTimeout(resolve, batchBreak));
                    if (activeBroadcast.stopped) break;
                } else {
                    // Normal random delay between messages
                    const waitTime = Math.floor((userMin + Math.random() * (userMax - userMin)) * 1000);
                    socket.emit('broadcast_status', { message: `⏸️ Cooling down ${Math.round(waitTime/1000)}s...` });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }

        const completionMsg = activeBroadcast.stopped ? 'Campaign stopped by user.' : `🎉 Campaign completed! Sent ${sentTotal} messages safely.`;
        socket.emit('broadcast_status', { message: completionMsg, done: true });
        activeBroadcast = null;
    });

    socket.on('stop_broadcast', () => {
        if (activeBroadcast) {
            activeBroadcast.stopped = true;
            socket.emit('broadcast_status', { message: 'Broadcast stopped by user', done: true });
        }
    });

    socket.on('refresh_qr', () => {
        console.log('Manual QR refresh requested.');
        startWhatsApp();
    });

    socket.on('pause_broadcast', (paused) => {
        if (activeBroadcast) {
            activeBroadcast.paused = paused;
            socket.emit('broadcast_status', { message: paused ? 'Broadcast paused' : 'Broadcast resumed' });
        }
    });

    // ---- LEAD SCRAPER (live streaming via socket) ----
    let scrapeAbort = false;

    socket.on('start_scrape', async (params) => {
        const { keywords, mobilePrefix, location, site, maxPages } = params;
        console.log('--- SCRAPE STARTED ---', { keywords, mobilePrefix, location, site, maxPages });
        if (!keywords) { socket.emit('scrape_done', { error: 'Keywords required' }); return; }

        scrapeAbort = false;
        const result = await scrapeWithPuppeteer(socket, params);
        socket.emit('scrape_done', { contacts: result.contacts, total: result.total, query: result.query, googleBlocked: false });
    });

    socket.on('stop_scrape', () => { scrapeAbort = true; });

    // ---- GROUP CONTACT EXTRACTOR ----
    socket.on('get_groups', async () => {
        if (!isConnected || !client) {
            return socket.emit('groups_list', { error: 'WhatsApp not connected' });
        }
        try {
            const chats = await client.getChats();
            const groups = chats.filter(c => c.isGroup).map(g => ({
                id: g.id._serialized,
                name: g.name,
                participantCount: g.participants ? g.participants.length : 0
            }));
            socket.emit('groups_list', { groups });
        } catch (err) {
            socket.emit('groups_list', { error: err.message });
        }
    });

    socket.on('extract_group_contacts', async (data) => {
        const { groupId } = data;
        if (!isConnected || !client) {
            return socket.emit('group_contacts', { error: 'WhatsApp not connected' });
        }
        if (!groupId) {
            return socket.emit('group_contacts', { error: 'No group selected' });
        }
        try {
            const chat = await client.getChatById(groupId);
            if (!chat.isGroup) {
                return socket.emit('group_contacts', { error: 'Not a group chat' });
            }
            // Fetch full participant list
            const participants = chat.participants || [];
            const contacts = participants.map(p => {
                const phone = p.id.user; // Just the number without @c.us
                return {
                    phone,
                    name: null,
                    isAdmin: p.isAdmin || p.isSuperAdmin || false,
                    source: 'group'
                };
            }).filter(c => c.phone && c.phone.length >= 9);

            // Try to get display names for participants
            for (let i = 0; i < contacts.length; i++) {
                try {
                    const contact = await client.getContactById(contacts[i].phone + '@c.us');
                    contacts[i].name = contact.pushname || contact.name || contact.shortName || null;
                } catch (e) {}
            }

            socket.emit('group_contacts', {
                groupId,
                groupName: chat.name,
                contacts,
                total: contacts.length
            });
        } catch (err) {
            socket.emit('group_contacts', { error: err.message });
        }
    });

    // Extract contacts from a group invite link (without joining)
    socket.on('extract_group_by_link', async (data) => {
        const { inviteLink } = data;
        if (!isConnected || !client) {
            return socket.emit('group_contacts', { error: 'WhatsApp not connected' });
        }
        if (!inviteLink) {
            return socket.emit('group_contacts', { error: 'No invite link provided' });
        }
        try {
            // Extract invite code from link (e.g. https://chat.whatsapp.com/ABC123)
            const inviteCode = inviteLink.trim().split('/').pop();
            if (!inviteCode || inviteCode.length < 10) {
                return socket.emit('group_contacts', { error: 'Invalid invite link format' });
            }

            // Get group metadata without joining
            const groupInfo = await client.getInviteInfo(inviteCode);
            if (!groupInfo) {
                return socket.emit('group_contacts', { error: 'Could not fetch group info. The link may be invalid or expired.' });
            }

            const participants = groupInfo.participants || [];
            const contacts = participants.map(p => {
                const phone = p.id ? (p.id.user || p.id._serialized?.split('@')[0]) : null;
                return {
                    phone,
                    name: null,
                    isAdmin: p.isAdmin || p.isSuperAdmin || false,
                    source: 'group_link'
                };
            }).filter(c => c.phone && c.phone.length >= 9);

            // Try to get display names
            for (let i = 0; i < Math.min(contacts.length, 50); i++) {
                try {
                    const contact = await client.getContactById(contacts[i].phone + '@c.us');
                    contacts[i].name = contact.pushname || contact.name || contact.shortName || null;
                } catch (e) {}
            }

            socket.emit('group_contacts', {
                groupId: groupInfo.id?._serialized || inviteCode,
                groupName: groupInfo.subject || 'Group via Invite Link',
                contacts,
                total: contacts.length
            });
        } catch (err) {
            socket.emit('group_contacts', { error: 'Failed: ' + (err.message || 'Could not access group. Link may be invalid or you may need to join first.') });
        }
    });
});

// ============================================================
// BOT CONTACTS API - Fetch from Supabase (credentials server-side only)
// ============================================================

const SUPABASE_URL = 'https://skmsrkkcwufkgynvpods.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrbXNya2tjd3Vma2d5bnZwb2RzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTc3MzYsImV4cCI6MjA5MDczMzczNn0.AFfqJq3IPIE3U62DCAeGESUa5AJZ_BjQCjj6SO96WYA';
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { transport: WebSocket } });

// --- AUTH: Login with VeloAI credentials ---
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        const userId = data.user.id;
        const token = data.session.access_token;

        // Look up businesses owned by this user
        const { data: businesses, error: bizError } = await supabaseClient
            .from('businesses')
            .select('*')
            .eq('owner_user_id', userId);

        if (bizError) throw bizError;

        res.json({
            user: { id: userId, email: data.user.email },
            token,
            businesses: (businesses || []).map(b => ({
                id: b.id,
                name: b.business_name,
                whatsapp: b.whatsapp_number,
                plan: b.plan || b.subscription_plan || 'full',
                crmAccess: b.crm_access || b.plan_type || 'full',
                billingStatus: b.subscription_status || 'active',
                nextDue: b.billing_next_due_at || null
            }))
        });
    } catch (err) {
        res.status(401).json({ error: err.message || 'Login failed' });
    }
});

// --- AUTH: Verify session token ---
app.post('/api/auth/verify', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const { data: { user }, error } = await supabaseClient.auth.getUser(token);
        if (error || !user) throw error || new Error('Invalid session');

        const { data: businesses } = await supabaseClient
            .from('businesses')
            .select('*')
            .eq('owner_user_id', user.id);

        res.json({
            user: { id: user.id, email: user.email },
            businesses: (businesses || []).map(b => ({
                id: b.id,
                name: b.business_name,
                whatsapp: b.whatsapp_number,
                plan: b.plan || b.subscription_plan || 'full',
                crmAccess: b.crm_access || b.plan_type || 'full',
                billingStatus: b.subscription_status || 'active',
                nextDue: b.billing_next_due_at || null
            }))
        });
    } catch (err) {
        res.status(401).json({ error: 'Session expired' });
    }
});

// --- Fetch bot contacts (requires businessId from logged-in user) ---
app.post('/api/bot-contacts', async (req, res) => {
    const { businessId, timeFilter } = req.body;
    if (!businessId) {
        return res.status(400).json({ error: 'Business ID is required' });
    }
    try {
        let query = supabaseClient
            .from('customers')
            .select('*')
            .eq('shop_id', businessId)
            .order('created_at', { ascending: false });

        // Apply time filter
        if (timeFilter === '7days') {
            const since = new Date();
            since.setDate(since.getDate() - 7);
            query = query.gte('created_at', since.toISOString());
        } else if (timeFilter === '30days') {
            const since = new Date();
            since.setDate(since.getDate() - 30);
            query = query.gte('created_at', since.toISOString());
        }

        const { data, error } = await query;
        if (error) throw error;

        const contacts = (data || []).map(row => ({
            phone: row.phone_number,
            name: row.name || null,
            source: 'bot',
            created_at: row.created_at
        })).filter(c => c.phone);

        res.json({ contacts, total: contacts.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// LEAD SCRAPER - Google via Puppeteer with live progress
// ============================================================

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function extractPhoneNumbers(text, mobilePrefix) {
    const found = [];
    const regex = /(\+?\d[\d\s\-().]{6,18}\d)/g;
    const matches = text.match(regex) || [];
    for (const raw of matches) {
        let digits = raw.replace(/[^\d]/g, '');
        if (digits.length < 9 || digits.length > 15) continue;
        if (/^(\d)\1+$/.test(digits)) continue;
        if (digits.startsWith('0000')) continue;
        if (mobilePrefix) {
            const prefix = mobilePrefix.replace(/[^\d]/g, '');
            if (prefix && !digits.startsWith(prefix) && !digits.startsWith('0')) continue;
        }
        found.push(digits);
    }
    return found;
}

// Puppeteer-based Google scraper (visible browser, like CRM extension)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeWithPuppeteer(socket, params) {
    const { keywords, mobilePrefix, location, site, maxPages } = params;
    const puppeteer = require('puppeteer-core');
    const contacts = [];
    const seen = new Set();
    const pages = Math.min(maxPages || 5, 10);
    let captchaConfirmed = false;
    // allow the socket to signal manual captcha solve
    socket.removeAllListeners('captcha_solved');
    socket.on('captcha_solved', () => { captchaConfirmed = true; });

    const parts = [];
    if (keywords) parts.push(keywords);
    if (location) parts.push(location);
    if (mobilePrefix) parts.push('"' + mobilePrefix + '"');
    if (site) parts.push('site:' + site);
    const query = parts.join(' ');

    let execPath = null;
    // On Linux servers, look for real Google Chrome first (most reliable), then chromium
    const linuxPaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
    for (const p of linuxPaths) {
        if (fs.existsSync(p)) { execPath = p; break; }
    }
    // Fallback: search puppeteer cache (handles both chrome.exe on Windows and chrome on Linux)
    if (!execPath) {
        const cacheDir = path.join(require('os').homedir(), '.cache', 'puppeteer');
        if (fs.existsSync(cacheDir)) {
            const find = (dir) => {
                for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, f.name);
                    if (f.isDirectory()) { const r = find(full); if (r) return r; }
                    else if (f.name === 'chrome.exe' || f.name === 'chrome') return full;
                }
                return null;
            };
            execPath = find(cacheDir);
        }
    }

    // Display detection: Xvfb on the server sets DISPLAY (e.g. :99) so we can run a VISIBLE browser
    // and stream it via VNC. Windows/local always has a display.
    const hasDisplay = process.platform === 'win32' || !!process.env.DISPLAY;
    const isServer = process.platform === 'linux';

    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: execPath || undefined,
            headless: hasDisplay ? false : 'new',
            userDataDir: path.join(__dirname, '.scraper_profile'),
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars', '--window-size=1280,800', '--lang=en-US',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--start-maximized'
            ],
            ignoreDefaultArgs: ['--enable-automation'],
        });

        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            window.chrome = { runtime: {} };
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 800 });

        for (let p = 0; p < pages; p++) {
            socket.emit('scrape_progress', { page: p + 1, totalPages: pages, found: contacts.length, status: 'searching', engine: 'google' });
            const searchUrl = 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&start=' + (p * 10) + '&num=10&hl=en&gl=us';
            let engineName = 'google';

            try {
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await sleep(2500 + Math.random() * 2000);

                // Accept Google consent if shown
                try {
                    await page.evaluate(() => {
                        const b = Array.from(document.querySelectorAll('button')).find(x => /accept all|i agree|agree/i.test(x.innerText));
                        if (b) b.click();
                    });
                    await sleep(1200);
                } catch (e) {}

                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await sleep(1000);

                let data = await page.evaluate(() => {
                    const t = document.body ? document.body.innerText : '';
                    const low = t.toLowerCase();
                    const blocked = low.includes('unusual traffic') || low.includes('are you a robot') || (low.includes('recaptcha') && t.length < 3000);
                    const tel = []; document.querySelectorAll('a[href^="tel:"]').forEach(a => tel.push(a.getAttribute('href').replace('tel:','')));
                    const titles = []; document.querySelectorAll('h3').forEach(e => { if (e.innerText.trim()) titles.push(e.innerText.trim()); });
                    const urls = []; document.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href')||''; if (h.startsWith('http') && !h.includes('google.') && !h.includes('gstatic') && !h.includes('youtube.com/redirect')) urls.push(h); });
                    return { text: t, titles, tel, blocked, len: t.length, urls };
                });

                if (data.blocked) {
                    if (!hasDisplay) {
                        // Truly headless (no Xvfb) — skip straight to DuckDuckGo
                        console.log('[Scrape] Page ' + (p+1) + ': Google blocked, no display -> DuckDuckGo');
                        socket.emit('scrape_progress', { page: p+1, totalPages: pages, found: contacts.length, status: 'google_blocked', engine: 'google' });
                        engineName = 'duckduckgo';
                        const dUrl = p === 0 ? 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&s=' + (p*30);
                        await page.goto(dUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                        await sleep(2000 + Math.random() * 1500);
                        data = await page.evaluate(() => {
                            const t = document.body ? document.body.innerText : '';
                            const tel = []; document.querySelectorAll('a[href^="tel:"]').forEach(a => tel.push(a.getAttribute('href').replace('tel:','')));
                            const titles = []; const urls = [];
                            document.querySelectorAll('a.result__a').forEach(a => { if (a.innerText.trim()) titles.push(a.innerText.trim()); });
                            document.querySelectorAll('a.result__url, a.result__a').forEach(a => { const h = a.getAttribute('href')||''; if (h.startsWith('http')) urls.push(h); });
                            return { text: t, titles, tel, blocked: false, len: t.length, urls };
                        });
                    } else {
                    console.log('[Scrape] Page ' + (p+1) + ': reCAPTCHA / block detected — waiting for user to solve');
                    // On the server, the visible browser is streamed via noVNC. Locally, a real window opens.
                    const vncUrl = isServer ? '/vnc/vnc.html?autoconnect=true&resize=remote' : null;
                    socket.emit('scrape_captcha', {
                        page: p+1,
                        vncUrl,
                        message: isServer
                            ? 'Google needs verification. Click "Open Browser" below to view the live browser and solve the reCAPTCHA — it will continue automatically.'
                            : 'Google needs verification. A browser window is open — please solve the reCAPTCHA there, then it will continue automatically.'
                    });

                    // Poll the page until captcha is solved (max ~3 minutes)
                    const maxWaitMs = 180000;
                    const startWait = Date.now();
                    let solved = false;
                    while (Date.now() - startWait < maxWaitMs) {
                        if (captchaConfirmed) { captchaConfirmed = false; }
                        await sleep(3000);
                        const stillBlocked = await page.evaluate(() => {
                            const t = (document.body ? document.body.innerText : '').toLowerCase();
                            return t.includes('unusual traffic') || t.includes('are you a robot') ||
                                   (t.includes('recaptcha') && t.length < 3000) ||
                                   !!document.querySelector('iframe[src*="recaptcha"], form#captcha-form, div#recaptcha');
                        }).catch(() => false);
                        if (!stillBlocked) { solved = true; break; }
                        socket.emit('scrape_captcha_waiting', { elapsed: Math.round((Date.now() - startWait) / 1000) });
                    }

                    if (solved) {
                        console.log('[Scrape] reCAPTCHA solved — resuming');
                        socket.emit('scrape_captcha_solved', { page: p+1 });
                        await sleep(2000);
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await sleep(1000);
                        // Re-read the page now that captcha is solved
                        data = await page.evaluate(() => {
                            const t = document.body ? document.body.innerText : '';
                            const tel = []; document.querySelectorAll('a[href^="tel:"]').forEach(a => tel.push(a.getAttribute('href').replace('tel:','')));
                            const titles = []; document.querySelectorAll('h3').forEach(e => { if (e.innerText.trim()) titles.push(e.innerText.trim()); });
                            const urls = []; document.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href')||''; if (h.startsWith('http') && !h.includes('google.') && !h.includes('gstatic') && !h.includes('youtube.com/redirect')) urls.push(h); });
                            return { text: t, titles, tel, blocked: false, len: t.length, urls };
                        });
                    } else {
                        // User didn't solve in time — fall back to DuckDuckGo
                        console.log('[Scrape] Captcha not solved in time -> DuckDuckGo');
                        socket.emit('scrape_progress', { page: p+1, totalPages: pages, found: contacts.length, status: 'google_blocked', engine: 'google' });
                        engineName = 'duckduckgo';
                        const dUrl = p === 0 ? 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&s=' + (p*30);
                        await page.goto(dUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                        await sleep(2000 + Math.random() * 1500);
                        data = await page.evaluate(() => {
                            const t = document.body ? document.body.innerText : '';
                            const tel = []; document.querySelectorAll('a[href^="tel:"]').forEach(a => tel.push(a.getAttribute('href').replace('tel:','')));
                            const titles = []; const urls = [];
                            document.querySelectorAll('a.result__a').forEach(a => { if (a.innerText.trim()) titles.push(a.innerText.trim()); });
                            document.querySelectorAll('a.result__url, a.result__a').forEach(a => { const h = a.getAttribute('href')||''; if (h.startsWith('http')) urls.push(h); });
                            return { text: t, titles, tel, blocked: false, len: t.length, urls };
                        });
                    }
                    }
                }

                console.log('[Scrape] Page ' + (p+1) + ' (' + engineName + '): ' + data.len + ' chars, ' + data.urls.length + ' urls, ' + data.tel.length + ' tel');

                // Extract from search page itself
                const direct = extractPhoneNumbers(data.text + ' ' + data.tel.join(' '), mobilePrefix);
                for (const phone of direct) {
                    if (!seen.has(phone)) {
                        seen.add(phone);
                        const c = { phone, name: data.titles[contacts.length % Math.max(data.titles.length,1)] || null, company: data.titles[contacts.length % Math.max(data.titles.length,1)] || null, city: location||null, category: keywords||null, source: site && site.includes('facebook') ? 'facebook' : site && site.includes('instagram') ? 'instagram' : engineName };
                        contacts.push(c);
                        socket.emit('scrape_number', { contact: c, total: contacts.length });
                    }
                }

                // Visit top result pages (the "2nd webpage" the CRM opens)
                const visit = data.urls.slice(0, 4);
                for (const u of visit) {
                    try {
                        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
                        await sleep(1500 + Math.random() * 1500);
                        const vd = await page.evaluate(() => {
                            const tel = []; document.querySelectorAll('a[href^="tel:"]').forEach(a => tel.push(a.getAttribute('href').replace('tel:','')));
                            return { text: document.body ? document.body.innerText : '', tel, title: document.title };
                        });
                        const vn = extractPhoneNumbers(vd.text + ' ' + vd.tel.join(' '), mobilePrefix);
                        for (const phone of vn) {
                            if (!seen.has(phone)) {
                                seen.add(phone);
                                const c = { phone, name: vd.title||null, company: vd.title||null, city: location||null, category: keywords||null, source: site && site.includes('facebook') ? 'facebook' : site && site.includes('instagram') ? 'instagram' : 'web' };
                                contacts.push(c);
                                socket.emit('scrape_number', { contact: c, total: contacts.length });
                            }
                        }
                        socket.emit('scrape_progress', { page: p+1, totalPages: pages, found: contacts.length, status: 'visiting', engine: engineName });
                    } catch (e) {}
                }

                socket.emit('scrape_progress', { page: p+1, totalPages: pages, found: contacts.length, status: 'extracting', engine: engineName });
            } catch (navErr) {
                console.error('[Scrape] Page ' + (p+1) + ' error:', navErr.message);
            }

            await sleep(3000 + Math.random() * 3000);
        }
    } catch (err) {
        console.error('[Scrape] Puppeteer error:', err.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    return { contacts, total: contacts.length, query };
}

app.post('/api/scrape-leads', async (req, res) => {
    res.json({ message: 'Use socket event start_scrape for live results' });
});

// ============================================================
// CONTACTS CRUD API - Save/Load from Supabase contacts table
// ============================================================

// Helper: create an authenticated supabase client with user's token
function getAuthClient(token) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        realtime: { transport: WebSocket },
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
}

// Load all contacts for a business
app.post('/api/contacts/load', async (req, res) => {
    const { businessId, token } = req.body;
    if (!businessId) return res.status(400).json({ error: 'Business ID required' });
    try {
        const client = token ? getAuthClient(token) : supabaseClient;
        const { data, error } = await client
            .from('contacts')
            .select('*')
            .eq('business_id', businessId)
            .eq('status', 'active')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ contacts: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save contacts (upsert - deduplicates by phone+business_id)
app.post('/api/contacts/save', async (req, res) => {
    const { businessId, contacts, token } = req.body;
    if (!businessId || !contacts || !contacts.length) {
        return res.status(400).json({ error: 'businessId and contacts array required' });
    }
    try {
        const client = token ? getAuthClient(token) : supabaseClient;
        const rows = contacts.map(c => ({
            business_id: businessId,
            phone: String(c.phone || '').replace(/[^\d]/g, ''),
            name: c.name || null,
            company: c.company || null,
            city: c.city || null,
            email: c.email || null,
            label: c.label || 'new_lead',
            source: c.source || 'manual',
            status: 'active',
            created_at: c.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
        })).filter(c => c.phone && c.phone.length >= 9);

        const { data, error } = await client
            .from('contacts')
            .upsert(rows, { onConflict: 'phone,business_id' })
            .select();

        if (error) throw error;
        res.json({ saved: (data || []).length, total: rows.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update label for contacts
app.post('/api/contacts/update-label', async (req, res) => {
    const { businessId, contactIds, label, token } = req.body;
    if (!businessId || !contactIds || !contactIds.length) {
        return res.status(400).json({ error: 'businessId and contactIds required' });
    }
    try {
        const client = token ? getAuthClient(token) : supabaseClient;
        const { error } = await client
            .from('contacts')
            .update({ label: label || 'new_lead', updated_at: new Date().toISOString() })
            .eq('business_id', businessId)
            .in('id', contactIds);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete contacts (soft delete)
app.post('/api/contacts/delete', async (req, res) => {
    const { businessId, contactIds, token } = req.body;
    if (!businessId || !contactIds || !contactIds.length) {
        return res.status(400).json({ error: 'businessId and contactIds required' });
    }
    try {
        const client = token ? getAuthClient(token) : supabaseClient;
        const { error } = await client
            .from('contacts')
            .update({ status: 'deleted', updated_at: new Date().toISOString() })
            .eq('business_id', businessId)
            .in('id', contactIds);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// LABEL METADATA - Persist label names/colors per business
// ============================================================
const LABELS_DIR = path.join(__dirname, '.labels_data');
fs.ensureDirSync(LABELS_DIR);

function getLabelsFilePath(businessId) {
    return path.join(LABELS_DIR, `${businessId}.json`);
}

// Save label metadata for a business
app.post('/api/labels/save', async (req, res) => {
    const { businessId, labels } = req.body;
    if (!businessId || !labels) return res.status(400).json({ error: 'businessId and labels required' });
    try {
        await fs.writeJson(getLabelsFilePath(businessId), labels);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Load label metadata for a business
app.post('/api/labels/load', async (req, res) => {
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    try {
        const filePath = getLabelsFilePath(businessId);
        if (await fs.pathExists(filePath)) {
            const labels = await fs.readJson(filePath);
            res.json({ labels });
        } else {
            res.json({ labels: [] });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected });
});

// Root route for development helper
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #0f172a; color: white; min-height: 100vh; padding-top: 50px;">
            <h1 style="color: #25D366;">WhatsApp Dashboard API (wwebjs)</h1>
            <p>The backend server is running successfully on port ${PORT}.</p>
            <div style="background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; border: 1px solid #334155;">
                <p>To see the Dashboard UI, please run:</p>
                <code style="background: black; padding: 5px 10px; border-radius: 5px; color: #fbbf24;">npm run dev-client</code>
                <p>in a separate terminal and open <a href="http://localhost:5173" style="color: #60a5fa;">http://localhost:5173</a></p>
            </div>
        </div>
    `);
});

// Serve static files from React app in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../client/dist')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    });
}

server.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🚀 SERVER RUNNING: http://localhost:${PORT}`);
    console.log(`🔗 DASHBOARD UI:  http://localhost:5173`);
    console.log(`===========================================\n`);
    startWhatsApp();
});

