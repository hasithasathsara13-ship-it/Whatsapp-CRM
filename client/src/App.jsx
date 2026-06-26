import React, { useState, useEffect, useRef, useMemo } from 'react';
import { io } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import * as XLSX from 'xlsx';

const socket = io('http://localhost:8790');

// Default label colors
const LABEL_COLORS = [
  '#4CAF50', '#FF5722', '#FF9800', '#2196F3', '#9C27B0',
  '#FFD700', '#00BCD4', '#8BC34A', '#E91E63', '#607D8B'
];

function App() {
  // Auth State
  const [authUser, setAuthUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wa_auth_user')); } catch { return null; }
  });
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('wa_auth_token') || null);
  const [businesses, setBusinesses] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wa_businesses')) || []; } catch { return []; }
  });
  const [activeBusiness, setActiveBusiness] = useState(() => localStorage.getItem('wa_active_business') || null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  const [activeTab, setActiveTab] = useState('connection');
  const [status, setStatus] = useState({ connected: false, user: null });
  const [qrCode, setQrCode] = useState(null);
  const [loading, setLoading] = useState(true);

  // Messaging State
  const [rawMessage, setRawMessage] = useState(localStorage.getItem('wa_msg') || '');

  // Contact Management State
  const [contacts, setContacts] = useState([]);
  const [labels, setLabels] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wa_crm_labels')) || []; } catch { return []; }
  });
  const [contactSource, setContactSource] = useState('spreadsheet');
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [filterLabel, setFilterLabel] = useState('all');
  const [contactsLoading, setContactsLoading] = useState(false);

  // Scraper State
  const [scrapeForm, setScrapeForm] = useState({ keywords: '', mobilePrefix: '', location: '', site: 'facebook.com', maxPages: 5 });
  const [scraping, setScraping] = useState(false);
  const [scrapeResults, setScrapeResults] = useState(null);
  const [scrapeProgress, setScrapeProgress] = useState({ page: 0, totalPages: 0, found: 0, status: '', engine: '' });
  const [scrapeLiveNumbers, setScrapeLiveNumbers] = useState([]);
  const [scrapeCaptcha, setScrapeCaptcha] = useState(null);

  // Spreadsheet Import State
  const [spreadsheetResults, setSpreadsheetResults] = useState(null);

  // Manual Entry State
  const [manualNumbers, setManualNumbers] = useState('');
  const [manualResults, setManualResults] = useState(null);

  // Bot Contact State
  const [fetchingBot, setFetchingBot] = useState(false);
  const [botResults, setBotResults] = useState(null);
  const [botTimeFilter, setBotTimeFilter] = useState('all');

  // Execution State
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, logs: [], results: {} });

  // Media State
  const [mediaFile, setMediaFile] = useState(null);
  const [docFile, setDocFile] = useState(null);
  const [mediaActive, setMediaActive] = useState(false);
  const [docActive, setDocActive] = useState(false);
  const [delay, setDelay] = useState({ min: 15, max: 45 });

  // New Label Modal
  const [showLabelModal, setShowLabelModal] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#4CAF50');

  // Persist labels locally (labels are lightweight metadata)
  useEffect(() => { localStorage.setItem('wa_crm_labels', JSON.stringify(labels)); }, [labels]);
  useEffect(() => { localStorage.setItem('wa_msg', rawMessage); }, [rawMessage]);

  // Persist auth
  useEffect(() => { if (authUser) localStorage.setItem('wa_auth_user', JSON.stringify(authUser)); else localStorage.removeItem('wa_auth_user'); }, [authUser]);
  useEffect(() => { if (authToken) localStorage.setItem('wa_auth_token', authToken); else localStorage.removeItem('wa_auth_token'); }, [authToken]);
  useEffect(() => { localStorage.setItem('wa_businesses', JSON.stringify(businesses)); }, [businesses]);
  useEffect(() => { if (activeBusiness) localStorage.setItem('wa_active_business', activeBusiness); }, [activeBusiness]);

  // Load contacts from Supabase when business is set
  const loadContactsFromDB = async (bizId) => {
    if (!bizId) return;
    setContactsLoading(true);
    try {
      const res = await fetch('http://localhost:8790/api/contacts/load', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: bizId, token: authToken })
      });
      const data = await res.json();
      if (data.contacts) {
        setContacts(data.contacts);
        // Extract unique labels from contacts
        const dbLabels = [...new Set(data.contacts.map(c => c.label).filter(Boolean))];
        setLabels(prev => {
          const existingIds = prev.map(l => l.id);
          const newLabels = dbLabels.filter(l => !existingIds.includes(l) && l !== 'new_lead').map((l, i) => ({
            id: l, name: l.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), color: LABEL_COLORS[i % LABEL_COLORS.length]
          }));
          return [...prev, ...newLabels];
        });
      }
    } catch (err) { console.error('Load contacts error:', err); }
    setContactsLoading(false);
  };

  // Load contacts when activeBusiness changes
  useEffect(() => { if (activeBusiness) loadContactsFromDB(activeBusiness); }, [activeBusiness]);

  // Verify stored session on mount
  useEffect(() => {
    if (!authToken) { setAuthChecking(false); return; }
    fetch('http://localhost:8790/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken })
    }).then(r => r.json()).then(data => {
      if (data.error) { handleAuthLogout(); }
      else {
        setAuthUser(data.user);
        setBusinesses(data.businesses || []);
        if (!activeBusiness && data.businesses?.length) setActiveBusiness(data.businesses[0].id);
      }
    }).catch(() => {}).finally(() => setAuthChecking(false));
  }, []);

  // Login handler
  const handleAuthLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await fetch('http://localhost:8790/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAuthUser(data.user);
      setAuthToken(data.token);
      setBusinesses(data.businesses || []);
      if (data.businesses?.length) setActiveBusiness(data.businesses[0].id);
      setLoginEmail(''); setLoginPassword('');
    } catch (err) {
      setLoginError(err.message || 'Login failed');
    }
    setLoginLoading(false);
  };

  const handleAuthLogout = () => {
    setAuthUser(null); setAuthToken(null); setBusinesses([]); setActiveBusiness(null);
    localStorage.removeItem('wa_auth_user'); localStorage.removeItem('wa_auth_token');
    localStorage.removeItem('wa_businesses'); localStorage.removeItem('wa_active_business');
  };

  // Socket events
  useEffect(() => {
    socket.on('status', (data) => { setStatus(data); setLoading(false); if (data.connected) setQrCode(null); });
    socket.on('qr', (data) => { setQrCode(data.qr); setLoading(false); });
    socket.on('broadcast_status', (data) => {
      setProgress(prev => ({
        ...prev,
        current: data.current || prev.current,
        total: data.total || prev.total,
        logs: [`[${new Date().toLocaleTimeString()}] ${data.message}`, ...prev.logs].slice(0, 50),
        results: data.number ? { ...prev.results, [data.number]: data.status } : prev.results
      }));
      if (data.done) setIsBroadcasting(false);
    });
    socket.on('scrape_progress', (data) => { setScrapeProgress(data); });
    socket.on('scrape_number', (data) => { setScrapeLiveNumbers(prev => [data.contact, ...prev].slice(0, 100)); });
    socket.on('scrape_captcha', (data) => { setScrapeCaptcha({ waiting: true, message: data.message, elapsed: 0 }); });
    socket.on('scrape_captcha_waiting', (data) => { setScrapeCaptcha(prev => prev ? { ...prev, elapsed: data.elapsed } : prev); });
    socket.on('scrape_captcha_solved', () => { setScrapeCaptcha(null); });
    socket.on('scrape_done', (data) => {
      setScraping(false);
      setScrapeCaptcha(null);
      if (data.error) { alert('Scrape error: ' + data.error); return; }
      setScrapeResults(data.contacts || []);
      setScrapeProgress(p => ({ ...p, status: 'done', found: data.total || 0 }));
    });
    return () => { socket.off('status'); socket.off('qr'); socket.off('broadcast_status'); socket.off('scrape_progress'); socket.off('scrape_number'); socket.off('scrape_done'); socket.off('scrape_captcha'); socket.off('scrape_captcha_waiting'); socket.off('scrape_captcha_solved'); };
  }, []);

  // --- LABEL MANAGEMENT ---
  const addLabel = () => {
    if (!newLabelName.trim()) return;
    const label = { id: `lbl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, name: newLabelName.trim(), color: newLabelColor };
    setLabels(prev => [...prev, label]);
    setNewLabelName('');
    setShowLabelModal(false);
    // Auto-select the new label in any active dropdown
    setTimeout(() => {
      const botSel = document.getElementById('bot-label-select');
      if (botSel) botSel.value = label.id;
      const spreadSel = document.getElementById('spreadsheet-label-select');
      if (spreadSel) spreadSel.value = label.id;
      const scrapeSel = document.getElementById('scrape-label-select');
      if (scrapeSel) scrapeSel.value = label.id;
      const manualSel = document.getElementById('manual-label-select');
      if (manualSel) manualSel.value = label.id;
    }, 100);
  };

  const deleteLabel = async (labelId) => {
    // Find all contacts under this label
    const toDelete = contacts.filter(c => c.label === labelId).map(c => c.id).filter(Boolean);
    // Delete those contacts from the database
    if (toDelete.length > 0) {
      await deleteContacts(toDelete);
    }
    // Remove the label itself
    setLabels(prev => prev.filter(l => l.id !== labelId));
  };

  // State for inline editing label names
  const [editingLabelId, setEditingLabelId] = useState(null);
  const [editingLabelName, setEditingLabelName] = useState('');

  const startEditLabel = (label) => {
    setEditingLabelId(label.id);
    setEditingLabelName(label.name);
  };

  const saveEditLabel = () => {
    if (!editingLabelName.trim()) { setEditingLabelId(null); return; }
    setLabels(prev => prev.map(l => l.id === editingLabelId ? { ...l, name: editingLabelName.trim() } : l));
    setEditingLabelId(null);
  };

  // --- CONTACT OPERATIONS (save to Supabase) ---
  const addContacts = async (newContacts, labelId = null) => {
    if (!activeBusiness) return 0;
    const cleaned = newContacts.map(c => ({
      phone: String(c.phone || '').replace(/[^\d]/g, ''),
      name: c.name || null,
      company: c.company || null,
      city: c.city || null,
      email: c.email || null,
      source: c.source || 'manual',
      label: labelId || 'new_lead',
      created_at: c.created_at || new Date().toISOString()
    })).filter(c => c.phone && c.phone.length >= 9 && c.phone.length <= 15);

    if (cleaned.length === 0) return 0;

    try {
      const res = await fetch('http://localhost:8790/api/contacts/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: activeBusiness, contacts: cleaned, token: authToken })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // Reload from DB to get the latest state
      await loadContactsFromDB(activeBusiness);
      return data.saved || cleaned.length;
    } catch (err) {
      console.error('Save contacts error:', err);
      alert('Failed to save contacts: ' + err.message);
      return 0;
    }
  };

  const setContactLabel = async (contactIds, labelId) => {
    if (!activeBusiness) return;
    try {
      await fetch('http://localhost:8790/api/contacts/update-label', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: activeBusiness, contactIds, label: labelId, token: authToken })
      });
      setContacts(prev => prev.map(c => contactIds.includes(c.id) ? { ...c, label: labelId } : c));
    } catch (err) { console.error('Update label error:', err); }
  };

  const deleteContacts = async (contactIds) => {
    if (!activeBusiness) return;
    try {
      await fetch('http://localhost:8790/api/contacts/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: activeBusiness, contactIds, token: authToken })
      });
      setContacts(prev => prev.filter(c => !contactIds.includes(c.id)));
    } catch (err) { console.error('Delete contacts error:', err); }
  };

  // --- PLAN ACCESS (gates features based on business plan) ---
  const activePlan = useMemo(() => {
    const biz = businesses.find(b => b.id === activeBusiness);
    if (!biz) return 'full';
    return biz.crmAccess || biz.plan || 'full';
    // 'full' = bot + crm + bot contacts
    // 'crm_only' = crm (spreadsheet, scraper, broadcast) but no bot contacts tab
    // 'bot_only' = no CRM access at all (shouldn't be able to login here)
  }, [businesses, activeBusiness]);

  // --- FILTERED CONTACTS ---
  const filteredContacts = useMemo(() => {
    let result = [...contacts];
    if (filterLabel !== 'all') {
      result = result.filter(c => c.label === filterLabel);
    }
    if (contactSearch) {
      const s = contactSearch.toLowerCase();
      result = result.filter(c =>
        (c.name || '').toLowerCase().includes(s) ||
        (c.phone || '').includes(s) ||
        (c.company || '').toLowerCase().includes(s)
      );
    }
    return result;
  }, [contacts, filterLabel, contactSearch]);

  // --- CAMPAIGN CONTACTS (by selected labels) ---
  const campaignContacts = useMemo(() => {
    if (selectedLabels.length === 0) return contacts;
    return contacts.filter(c => selectedLabels.includes(c.label));
  }, [contacts, selectedLabels]);

  // --- SPREADSHEET IMPORT ---
  const handleExcelUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const data = new Uint8Array(event.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const extracted = [];
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const headers = rows[0] || [];
        const phoneIdx = headers.findIndex(h => /phone|mobile|number|whatsapp|telefono/i.test(String(h)));
        const nameIdx = headers.findIndex(h => /name|nombre|contact/i.test(String(h)));
        const companyIdx = headers.findIndex(h => /company|business|empresa/i.test(String(h)));
        const cityIdx = headers.findIndex(h => /city|location|ciudad/i.test(String(h)));

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          let phone = phoneIdx >= 0 ? String(row[phoneIdx] || '') : '';
          if (!phone) { row.forEach(cell => { if (!phone && cell) { const v = String(cell).replace(/\D/g, ''); if (v.length >= 9 && v.length <= 15) phone = v; } }); }
          if (phone) {
            extracted.push({
              phone: phone.replace(/[^\d+]/g, ''),
              name: nameIdx >= 0 ? String(row[nameIdx] || '') : null,
              company: companyIdx >= 0 ? String(row[companyIdx] || '') : null,
              city: cityIdx >= 0 ? String(row[cityIdx] || '') : null,
              source: 'spreadsheet'
            });
          }
        }
      });
      if (extracted.length > 0) {
        setSpreadsheetResults(extracted);
      } else { alert('No phone numbers found in the spreadsheet.'); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const importSpreadsheetResults = async (labelId) => {
    if (!spreadsheetResults || spreadsheetResults.length === 0) return;
    const added = await addContacts(spreadsheetResults, labelId);
    alert(`Saved ${added} contacts from spreadsheet (duplicates skipped).`);
    setSpreadsheetResults(null);
  };

  // --- MANUAL ENTRY ---
  const parseManualNumbers = () => {
    if (!manualNumbers.trim()) return alert('Please enter phone numbers');
    const items = manualNumbers.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
    const parsed = items.map(item => {
      const phone = item.replace(/[^\d+]/g, '').replace(/^\+/, '');
      return { phone, name: null, source: 'manual' };
    }).filter(c => c.phone.length >= 9 && c.phone.length <= 15);

    if (parsed.length === 0) return alert('No valid phone numbers found');
    setManualResults(parsed);
  };

  const importManualResults = async (labelId) => {
    if (!manualResults || manualResults.length === 0) return;
    const added = await addContacts(manualResults, labelId);
    alert(`Saved ${added} contacts (duplicates skipped).`);
    setManualResults(null);
    setManualNumbers('');
  };

  // --- LEAD SCRAPER ---
  const startScraping = () => {
    if (!scrapeForm.keywords.trim()) return alert('Enter keywords to search');
    setScraping(true);
    setScrapeResults(null);
    setScrapeLiveNumbers([]);
    setScrapeProgress({ page: 0, totalPages: scrapeForm.maxPages, found: 0, status: 'starting', engine: '' });
    socket.emit('start_scrape', scrapeForm);
  };

  const stopScraping = () => {
    socket.emit('stop_scrape');
    setScraping(false);
  };

  const importScrapeResults = async (labelId) => {
    if (!scrapeResults || scrapeResults.length === 0) return;
    const added = await addContacts(scrapeResults.map(c => ({ ...c, source: c.source || 'scraper' })), labelId);
    alert(`Added ${added} contacts from scraper (duplicates skipped).`);
    setScrapeResults(null);
  };

  // --- BOT CONTACTS ---
  const fetchBotContacts = async () => {
    if (!activeBusiness) {
      return alert('No business linked to your account. Contact support.');
    }
    setFetchingBot(true);
    setBotResults(null);
    try {
      const res = await fetch('http://localhost:8790/api/bot-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: activeBusiness, timeFilter: botTimeFilter })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Filter out numbers that already exist in contacts (deduplication)
      const existingPhones = new Set(contacts.map(c => c.phone));
      const newContacts = (data.contacts || []).filter(c => {
        const phone = String(c.phone || '').replace(/[^\d]/g, '');
        return phone && !existingPhones.has(phone);
      });

      setBotResults({ all: data.contacts || [], new: newContacts, duplicates: (data.contacts || []).length - newContacts.length });
    } catch (err) {
      alert('Failed to fetch bot contacts: ' + err.message);
    }
    setFetchingBot(false);
  };

  const importBotResults = async (labelId) => {
    if (!botResults || botResults.new.length === 0) return;
    const added = await addContacts(botResults.new.map(c => ({ ...c, source: 'bot' })), labelId);
    alert(`Saved ${added} bot contacts to database.`);
    setBotResults(null);
  };

  // --- MEDIA HANDLING ---
  const handleFileChange = (e, target) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const fileData = { name: file.name, type: file.type, data: event.target.result };
      if (target === 'media') setMediaFile(fileData);
      else setDocFile(fileData);
    };
    reader.readAsDataURL(file);
  };

  // --- BROADCAST ---
  const handleStartBroadcast = () => {
    if (!status.connected) return alert('Please connect WhatsApp first!');
    const targets = campaignContacts.map(c => c.phone).filter(Boolean);
    if (targets.length === 0) return alert('No contacts selected for this campaign!');

    setIsBroadcasting(true);
    setIsPaused(false);
    setProgress({ current: 0, total: targets.length, logs: ['Starting broadcast...'], results: {} });

    socket.emit('start_broadcast', {
      numbers: targets,
      message: rawMessage,
      delay,
      media: mediaActive ? mediaFile : null,
      document: docActive ? docFile : null
    });
  };

  const handleStopBroadcast = () => { socket.emit('stop_broadcast'); setIsBroadcasting(false); setIsPaused(false); };
  const handlePauseBroadcast = () => { const s = !isPaused; setIsPaused(s); socket.emit('pause_broadcast', s); };
  const handleLogout = () => { setLoading(true); socket.emit('logout'); };
  const handleRefreshQR = () => { socket.emit('refresh_qr'); };

  // --- WHATSAPP PREVIEW ---
  const formatPreview = (text) => {
    let formatted = text
      .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
      .replace(/_(.*?)_/g, '<em>$1</em>')
      .replace(/~(.*?)~/g, '<del>$1</del>')
      .replace(/`(.*?)`/g, '<code class="bg-black/20 px-1 rounded">$1</code>')
      .replace(/\n/g, '<br/>');
    return <div dangerouslySetInnerHTML={{ __html: formatted }} />;
  };

  // --- LOADING SCREEN ---
  if (authChecking) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-[#0f172a] text-white">
        <i className="fas fa-circle-notch fa-spin text-3xl text-whatsapp-light mb-4"></i>
        <p className="text-slate-400">Checking session...</p>
      </div>
    );
  }

  // --- LOGIN SCREEN ---
  if (!authUser) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-[#070b14] text-white px-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center space-x-3 mb-8">
            <div className="w-12 h-12 bg-whatsapp-light rounded-xl flex items-center justify-center text-white text-2xl shadow-[0_0_20px_rgba(37,211,102,0.4)]">
              <i className="fab fa-whatsapp"></i>
            </div>
            <div>
              <h1 className="text-2xl font-bold">Velo.ai <span className="text-whatsapp-light">Bulk Pro</span></h1>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">CRM Edition</p>
            </div>
          </div>

          <div className="glass p-8 rounded-[2rem] border-white/5">
            <h2 className="text-lg font-bold mb-2 text-center">Sign In</h2>
            <p className="text-xs text-slate-400 text-center mb-6">Use your VeloAI account credentials</p>

            <form onSubmit={handleAuthLogin} className="space-y-4">
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase">Email</label>
                <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required
                  className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1 focus:outline-none focus:border-whatsapp-light/50" placeholder="your@email.com" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase">Password</label>
                <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required
                  className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1 focus:outline-none focus:border-whatsapp-light/50" placeholder="••••••••" />
              </div>
              {loginError && <p className="text-xs text-red-400 bg-red-500/10 p-2 rounded-lg">{loginError}</p>}
              <button type="submit" disabled={loginLoading}
                className="w-full py-3 bg-whatsapp-light text-white rounded-xl font-bold text-sm shadow-lg shadow-whatsapp-light/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50">
                {loginLoading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          </div>
          <p className="text-[10px] text-slate-600 text-center mt-6">Powered by Velo.AI</p>
        </div>
      </div>
    );
  }

  // --- BOT-ONLY PLAN: No CRM access ---
  if (activePlan === 'bot_only') {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-[#070b14] text-white px-4">
        <div className="w-full max-w-sm text-center space-y-6">
          <div className="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center text-amber-400 text-3xl mx-auto">
            <i className="fas fa-lock"></i>
          </div>
          <h2 className="text-xl font-bold">CRM Not Available</h2>
          <p className="text-sm text-slate-400">Your current plan includes the WhatsApp Bot only. Upgrade to access the Bulk CRM dashboard with contact management, lead scraping, and broadcasting.</p>
          <p className="text-xs text-slate-500">Contact your administrator to upgrade your plan.</p>
          <button onClick={handleAuthLogout} className="px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold hover:bg-white/10">Logout</button>
        </div>
      </div>
    );
  }

  // --- SUBSCRIPTION EXPIRED CHECK ---
  const activeBiz = businesses.find(b => b.id === activeBusiness);
  const isExpired = (() => {
    if (!activeBiz) return false;
    if (activeBiz.billingStatus === 'past_due' || activeBiz.billingStatus === 'expired' || activeBiz.billingStatus === 'suspended') return true;
    if (activeBiz.nextDue) {
      const dueDate = new Date(activeBiz.nextDue);
      if (dueDate < new Date()) return true;
    }
    return false;
  })();

  if (loading) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-[#0f172a] text-white">
        <div className="flex space-x-2">
          <div className="w-3 h-3 bg-whatsapp-light rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
          <div className="w-3 h-3 bg-whatsapp-light rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
          <div className="w-3 h-3 bg-whatsapp-light rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
        </div>
        <p className="mt-4 text-slate-400 font-medium">Powering up Dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[#070b14] text-slate-200 flex flex-col items-center">
      {/* Header */}
      <header className="w-full max-w-6xl flex justify-between items-center p-6 border-b border-white/5 bg-black/20 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-whatsapp-light rounded-xl flex items-center justify-center text-white text-xl shadow-[0_0_15px_rgba(37,211,102,0.4)]">
            <i className="fab fa-whatsapp"></i>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Velo.ai <span className="text-whatsapp-light">Bulk Pro</span></h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">CRM Edition v3.0</p>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-xs text-slate-500">{authUser?.email}</span>
          {businesses.length > 1 && (
            <select value={activeBusiness || ''} onChange={e => setActiveBusiness(e.target.value)} className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-[10px]">
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <span className="text-xs text-slate-500">{contacts.length} contacts</span>
          <div className={`px-4 py-1.5 rounded-full text-[10px] font-black flex items-center space-x-2 border ${status.connected ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
            <span className={`w-2 h-2 rounded-full ${status.connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></span>
            <span>{status.connected ? 'WA LIVE' : 'OFFLINE'}</span>
          </div>
          <button onClick={handleAuthLogout} className="text-xs text-slate-500 hover:text-red-400 transition-all" title="Logout"><i className="fas fa-sign-out-alt"></i></button>
        </div>
      </header>

      {/* Navigation */}
      <nav className="w-full max-w-6xl px-6 py-4 flex space-x-2 overflow-x-auto no-scrollbar">
        {[
          { id: 'connection', label: 'Connect', icon: 'fa-link' },
          { id: 'message', label: 'Message', icon: 'fa-comment-alt' },
          { id: 'contacts', label: 'Contacts', icon: 'fa-users' },
          { id: 'broadcast', label: 'Broadcast', icon: 'fa-paper-plane' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-xl transition-all font-bold text-sm border ${activeTab === tab.id ? 'bg-whatsapp-light/10 text-whatsapp-light border-whatsapp-light/30 shadow-lg shadow-whatsapp-light/5' : 'bg-white/5 border-transparent text-slate-400 hover:bg-white/10'}`}>
            <i className={`fas ${tab.icon}`}></i>
            <span>{tab.label}</span>
            {tab.id === 'contacts' && <span className="ml-1 px-1.5 py-0.5 bg-white/10 rounded text-[10px]">{contacts.length}</span>}
          </button>
        ))}
      </nav>

      <main className="w-full max-w-6xl p-6 flex-1 flex flex-col items-center">
        <AnimatePresence mode="wait">

          {/* CONNECTION TAB */}
          {activeTab === 'connection' && (
            <motion.div key="connection" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full max-w-xl">
              {!status.connected ? (
                <div className="glass p-10 rounded-[2.5rem] premium-shadow w-full flex flex-col items-center border-white/5">
                  <h2 className="text-2xl font-bold mb-2">Device Link</h2>
                  <p className="text-slate-400 text-center mb-8 text-sm">Scan the QR code to link your WhatsApp account.</p>
                  <div className="p-4 bg-white rounded-3xl mb-8 shadow-2xl">
                    {qrCode ? (
                      <img src={qrCode} alt="WhatsApp QR" className="w-64 h-64" />
                    ) : (
                      <div className="w-64 h-64 flex flex-col items-center justify-center text-slate-800">
                        <i className="fas fa-circle-notch fa-spin text-4xl mb-4 text-whatsapp-light"></i>
                        <p className="text-sm font-bold">Fetching QR...</p>
                      </div>
                    )}
                  </div>
                  <button onClick={handleRefreshQR} className="text-xs font-bold text-whatsapp-light hover:underline">Refresh Code</button>
                </div>
              ) : (
                <div className="glass p-10 rounded-[2.5rem] premium-shadow w-full flex flex-col items-center border-white/5">
                  <div className="w-24 h-24 bg-whatsapp-light/10 rounded-full flex items-center justify-center text-whatsapp-light text-5xl mb-6">
                    <i className="fas fa-shield-alt"></i>
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Authenticated</h2>
                  <p className="text-slate-400 text-center mb-8">Successfully linked to device.</p>
                  <div className="bg-white/5 p-6 rounded-3xl w-full flex items-center space-x-4 mb-8 border border-white/5">
                    <div className="w-14 h-14 bg-gradient-to-br from-whatsapp-light to-whatsapp-teal rounded-full flex items-center justify-center text-2xl font-bold">
                      {status.user?.name ? status.user.name.charAt(0) : <i className="fas fa-user-check"></i>}
                    </div>
                    <div>
                      <p className="text-lg font-bold">{status.user?.name || 'Authorized Device'}</p>
                      <p className="text-xs text-slate-500 font-mono">{status.user?.id ? status.user.id.split('@')[0] : 'Connected'}</p>
                    </div>
                  </div>
                  <button onClick={handleLogout} className="w-full py-4 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-2xl font-bold border border-red-500/20">Disconnect Session</button>
                </div>
              )}
            </motion.div>
          )}

          {/* MESSAGE TAB */}
          {activeTab === 'message' && (
            <motion.div key="message" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full flex flex-col lg:flex-row gap-8">
              <div className="flex-1 space-y-6">
                <div className="glass p-8 rounded-[2rem] border-white/5">
                  <h3 className="text-lg font-bold mb-4 flex items-center space-x-2"><i className="fas fa-pen-nib text-whatsapp-light"></i><span>Template Editor</span></h3>
                  <textarea value={rawMessage} onChange={(e) => setRawMessage(e.target.value)}
                    className="w-full h-64 bg-black/30 border border-white/5 rounded-2xl p-6 text-slate-100 focus:outline-none focus:border-whatsapp-light/50 resize-none font-medium text-base"
                    placeholder="Type your WhatsApp message..." />
                  <div className="mt-4 flex flex-wrap gap-2">
                    {['*Bold*', '_Italic_', '~Strike~', '`Mono`'].map(tag => (
                      <button key={tag} onClick={() => setRawMessage(prev => prev + tag)} className="px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-xs font-mono text-slate-400 border border-white/5">{tag}</button>
                    ))}
                  </div>
                </div>
                <div className="glass p-8 rounded-[2rem] border-white/5">
                  <h3 className="text-lg font-bold mb-4">Media Attachments</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <button className={`p-4 rounded-2xl border flex flex-col items-center space-y-2 ${mediaActive ? 'bg-whatsapp-light/10 border-whatsapp-light/30 text-whatsapp-light' : 'bg-white/5 border-white/5 text-slate-500'}`} onClick={() => setMediaActive(!mediaActive)}>
                      <i className="fas fa-image text-2xl"></i><span className="text-xs font-bold">Image/Video</span>
                    </button>
                    <button className={`p-4 rounded-2xl border flex flex-col items-center space-y-2 ${docActive ? 'bg-whatsapp-teal/10 border-whatsapp-teal/30 text-whatsapp-teal' : 'bg-white/5 border-white/5 text-slate-500'}`} onClick={() => setDocActive(!docActive)}>
                      <i className="fas fa-file-pdf text-2xl"></i><span className="text-xs font-bold">Document</span>
                    </button>
                  </div>
                  <div className="space-y-3 mt-4">
                    {mediaActive && (
                      <div className="p-4 bg-white/5 rounded-xl border border-dashed border-white/20 text-center">
                        <input type="file" className="hidden" id="wa-media" accept="image/*,video/*" onChange={(e) => handleFileChange(e, 'media')} />
                        <label htmlFor="wa-media" className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">{mediaFile ? `✅ ${mediaFile.name}` : 'Click to select Image or Video'}</label>
                      </div>
                    )}
                    {docActive && (
                      <div className="p-4 bg-white/5 rounded-xl border border-dashed border-white/20 text-center">
                        <input type="file" className="hidden" id="wa-doc" onChange={(e) => handleFileChange(e, 'doc')} />
                        <label htmlFor="wa-doc" className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">{docFile ? `✅ ${docFile.name}` : 'Click to select Document/PDF'}</label>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {/* Live Preview */}
              <div className="w-full lg:w-96">
                <div className="glass p-6 rounded-[2rem] border-white/5 bg-[#0b141a] h-full flex flex-col relative">
                  <div className="bg-[#121b22] p-4 flex items-center space-x-3 border-b border-white/5 rounded-t-[2rem]">
                    <div className="w-8 h-8 rounded-full bg-slate-600 flex items-center justify-center"><i className="fas fa-user text-sm"></i></div>
                    <span className="text-sm font-bold">Recipient Preview</span>
                  </div>
                  <div className="flex-1 p-4 overflow-y-auto">
                    {mediaActive && mediaFile && mediaFile.type.startsWith('image/') && (
                      <div className="bg-[#202c33] rounded-xl overflow-hidden mb-2"><img src={mediaFile.data} alt="Preview" className="w-full object-cover max-h-48" /></div>
                    )}
                    <div className="bg-[#202c33] rounded-xl p-3 text-[13px] text-[#e9edef]">
                      {formatPreview(rawMessage || 'Your message will appear here...')}
                      <div className="text-[9px] text-[#8696a0] text-right mt-1">11:15 PM</div>
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-600 text-center py-2">LIVE PREVIEW</p>
                </div>
              </div>
            </motion.div>
          )}

          {/* CONTACTS TAB */}
          {activeTab === 'contacts' && (
            <motion.div key="contacts" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full space-y-6">
              {/* Source Tabs */}
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'spreadsheet', label: 'Spreadsheet', icon: 'fa-file-excel' },
                  { id: 'manual', label: 'Manual Entry', icon: 'fa-keyboard' },
                  { id: 'scraper', label: 'Lead Scraper', icon: 'fa-search' },
                  ...(activePlan !== 'crm_only' ? [{ id: 'bot', label: 'Bot Contacts', icon: 'fa-robot' }] : []),
                  { id: 'manage', label: 'Manage', icon: 'fa-tags' },
                ].map(src => (
                  <button key={src.id} onClick={() => setContactSource(src.id)}
                    className={`flex items-center space-x-2 px-5 py-2 rounded-xl text-xs font-bold border transition-all ${contactSource === src.id ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' : 'bg-white/5 border-white/5 text-slate-400 hover:bg-white/10'}`}>
                    <i className={`fas ${src.icon}`}></i><span>{src.label}</span>
                  </button>
                ))}
              </div>

              {/* SPREADSHEET SOURCE */}
              {contactSource === 'spreadsheet' && (
                <div className="glass p-8 rounded-[2rem] border-white/5 space-y-6">
                  <h3 className="text-lg font-bold mb-4 flex items-center space-x-2"><i className="fas fa-file-excel text-green-400"></i><span>Import from Spreadsheet</span></h3>
                  <p className="text-sm text-slate-400 mb-6">Upload CSV or Excel files. Phone numbers will be auto-detected from columns named phone, mobile, whatsapp, number, etc.</p>
                  <div className="border-2 border-dashed border-white/10 rounded-2xl p-8 text-center hover:border-whatsapp-light/30 transition-all">
                    <input type="file" id="wa-excel" className="hidden" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} />
                    <label htmlFor="wa-excel" className="cursor-pointer flex flex-col items-center space-y-3">
                      <i className="fas fa-cloud-upload-alt text-4xl text-slate-500"></i>
                      <span className="text-sm font-bold text-slate-300">Drop file or click to upload</span>
                      <span className="text-xs text-slate-500">Supports .xlsx, .xls, .csv</span>
                    </label>
                  </div>

                  {spreadsheetResults && (
                    <div className="bg-black/30 rounded-2xl p-6 border border-white/5 space-y-4">
                      <p className="text-sm font-bold text-green-400">✅ Found {spreadsheetResults.length} contacts</p>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {spreadsheetResults.slice(0, 20).map((c, i) => (
                          <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-white/5">
                            <span className="text-slate-300 font-mono">{c.phone}</span>
                            <span className="text-slate-500">{c.name || c.company || 'Spreadsheet'}</span>
                          </div>
                        ))}
                        {spreadsheetResults.length > 20 && <p className="text-xs text-slate-500">...and {spreadsheetResults.length - 20} more</p>}
                      </div>

                      <div className="bg-black/20 rounded-xl p-4 border border-white/5 space-y-3">
                        <p className="text-xs font-bold text-slate-400 uppercase">Assign a label before saving</p>
                        <div className="flex items-center gap-3">
                          <select id="spreadsheet-label-select" onChange={(e) => { if (e.target.value === '__new__') { setShowLabelModal(true); e.target.value = ''; } }}
                            className="bg-black/30 border border-white/10 rounded-xl p-2.5 text-sm flex-1">
                            <option value="">No label</option>
                            {labels.map(l => <option key={l.id} value={l.id}>⬤ {l.name}</option>)}
                            <option value="__new__">＋ Create new label...</option>
                          </select>
                          <button onClick={() => { const sel = document.getElementById('spreadsheet-label-select'); importSpreadsheetResults(sel.value || null); }}
                            className="px-6 py-2.5 bg-whatsapp-light/20 text-whatsapp-light border border-whatsapp-light/30 rounded-xl font-bold text-sm whitespace-nowrap">
                            + Save All Contacts
                          </button>
                        </div>
                        {labels.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {labels.map(l => (
                              <button key={l.id} onClick={() => { document.getElementById('spreadsheet-label-select').value = l.id; }}
                                className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-all cursor-pointer">
                                <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.color }}></span>
                                <span className="text-[10px] font-bold text-slate-300">{l.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {labels.length === 0 && (
                          <p className="text-[11px] text-slate-500">No labels yet. Select "Create new label" above to organize your contacts.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* MANUAL ENTRY SOURCE */}
              {contactSource === 'manual' && (
                <div className="glass p-8 rounded-[2rem] border-white/5 space-y-6">
                  <h3 className="text-lg font-bold flex items-center space-x-2"><i className="fas fa-keyboard text-cyan-400"></i><span>Manual Entry</span></h3>
                  <p className="text-sm text-slate-400">Paste phone numbers separated by commas, new lines, or semicolons.</p>
                  <textarea value={manualNumbers} onChange={e => setManualNumbers(e.target.value)}
                    className="w-full h-40 bg-black/30 border border-white/10 rounded-2xl p-4 text-sm text-slate-100 font-mono focus:outline-none focus:border-cyan-400/50 resize-none"
                    placeholder="94771234567, 94772345678, 94773456789&#10;or one per line..." />
                  <button onClick={parseManualNumbers}
                    className="px-8 py-3 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-xl font-bold text-sm hover:bg-cyan-500/30">
                    <i className="fas fa-check mr-2"></i>Parse Numbers
                  </button>

                  {manualResults && (
                    <div className="bg-black/30 rounded-2xl p-6 border border-white/5 space-y-4">
                      <p className="text-sm font-bold text-green-400">✅ {manualResults.length} valid numbers parsed</p>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {manualResults.slice(0, 20).map((c, i) => (
                          <div key={i} className="flex items-center text-xs py-1 border-b border-white/5">
                            <span className="text-slate-300 font-mono">{c.phone}</span>
                          </div>
                        ))}
                        {manualResults.length > 20 && <p className="text-xs text-slate-500">...and {manualResults.length - 20} more</p>}
                      </div>

                      <div className="bg-black/20 rounded-xl p-4 border border-white/5 space-y-3">
                        <p className="text-xs font-bold text-slate-400 uppercase">Assign a label before saving</p>
                        <div className="flex items-center gap-3">
                          <select id="manual-label-select" onChange={(e) => { if (e.target.value === '__new__') { setShowLabelModal(true); e.target.value = ''; } }}
                            className="bg-black/30 border border-white/10 rounded-xl p-2.5 text-sm flex-1">
                            <option value="">No label</option>
                            {labels.map(l => <option key={l.id} value={l.id}>⬤ {l.name}</option>)}
                            <option value="__new__">＋ Create new label...</option>
                          </select>
                          <button onClick={() => { const sel = document.getElementById('manual-label-select'); importManualResults(sel.value || null); }}
                            className="px-6 py-2.5 bg-whatsapp-light/20 text-whatsapp-light border border-whatsapp-light/30 rounded-xl font-bold text-sm whitespace-nowrap">
                            + Save All Contacts
                          </button>
                        </div>
                        {labels.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {labels.map(l => (
                              <button key={l.id} onClick={() => { document.getElementById('manual-label-select').value = l.id; }}
                                className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-all cursor-pointer">
                                <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.color }}></span>
                                <span className="text-[10px] font-bold text-slate-300">{l.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {labels.length === 0 && (
                          <p className="text-[11px] text-slate-500">No labels yet. Select "Create new label" above to organize your contacts.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* SCRAPER SOURCE */}
              {contactSource === 'scraper' && (
                <div className="glass p-8 rounded-[2rem] border-white/5 space-y-6">
                  <h3 className="text-lg font-bold flex items-center space-x-2"><i className="fas fa-search text-orange-400"></i><span>Lead Scraper</span></h3>
                  <p className="text-sm text-slate-400">Scrapes Google (primary) with DuckDuckGo fallback. Extracts phone numbers from search results.</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Keywords *</label>
                      <input value={scrapeForm.keywords} onChange={e => setScrapeForm({...scrapeForm, keywords: e.target.value})}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1" placeholder="e.g., Saloons, Restaurants" />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Mobile Prefix</label>
                      <input value={scrapeForm.mobilePrefix} onChange={e => setScrapeForm({...scrapeForm, mobilePrefix: e.target.value})}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1" placeholder="e.g., +94, +91" />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Location</label>
                      <input value={scrapeForm.location} onChange={e => setScrapeForm({...scrapeForm, location: e.target.value})}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1" placeholder="e.g., Colombo, Mumbai" />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Site Filter</label>
                      <select value={scrapeForm.site} onChange={e => setScrapeForm({...scrapeForm, site: e.target.value})}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1">
                        <option value="facebook.com">Facebook</option>
                        <option value="instagram.com">Instagram</option>
                        <option value="linkedin.com">LinkedIn</option>
                        <option value="">Any Site</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Max Pages</label>
                      <input type="number" value={scrapeForm.maxPages} onChange={e => setScrapeForm({...scrapeForm, maxPages: parseInt(e.target.value)||5})}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1" min="1" max="10" />
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button onClick={startScraping} disabled={scraping}
                      className="px-8 py-3 bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-xl font-bold text-sm hover:bg-orange-500/30 disabled:opacity-50">
                      {scraping ? <><i className="fas fa-circle-notch fa-spin mr-2"></i>Scraping...</> : <><i className="fas fa-search mr-2"></i>Start Scraping</>}
                    </button>
                    {scraping && (
                      <button onClick={stopScraping} className="px-6 py-3 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl font-bold text-sm">
                        <i className="fas fa-stop mr-2"></i>Stop
                      </button>
                    )}
                  </div>

                  {/* Captcha Notification Banner */}
                  {scrapeCaptcha && scrapeCaptcha.waiting && (
                    <div className="bg-amber-500/10 border border-amber-500/40 rounded-2xl p-5 space-y-3 animate-pulse">
                      <div className="flex items-center space-x-3">
                        <i className="fas fa-shield-halved text-amber-400 text-2xl"></i>
                        <div>
                          <p className="text-sm font-bold text-amber-400">Verification Required</p>
                          <p className="text-xs text-slate-300">{scrapeCaptcha.message}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-slate-400">
                          <i className="fas fa-circle-notch fa-spin mr-1"></i>
                          Waiting for you to solve it... {scrapeCaptcha.elapsed > 0 ? `(${scrapeCaptcha.elapsed}s)` : ''}
                        </p>
                        <button onClick={() => socket.emit('captcha_solved')}
                          className="px-4 py-2 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-xl text-xs font-bold hover:bg-amber-500/30">
                          I've Solved It — Continue
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Live Progress */}
                  {scraping && (
                    <div className="bg-black/30 rounded-2xl p-5 border border-white/5 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold text-slate-400">
                          Page {scrapeProgress.page}/{scrapeProgress.totalPages}
                          {scrapeProgress.engine && <span className="ml-2 px-2 py-0.5 bg-white/5 rounded text-[10px]">{scrapeProgress.engine}</span>}
                        </p>
                        <p className="text-sm font-bold text-whatsapp-light">{scrapeProgress.found} numbers found</p>
                      </div>
                      {scrapeProgress.status === 'google_blocked' && (
                        <p className="text-xs text-amber-400">⚠️ Google blocked — switching to DuckDuckGo...</p>
                      )}
                      {/* Progress Bar */}
                      <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-orange-500 to-yellow-500 transition-all duration-500"
                          style={{ width: `${scrapeProgress.totalPages ? (scrapeProgress.page / scrapeProgress.totalPages) * 100 : 0}%` }}></div>
                      </div>
                      {/* Live Number Feed */}
                      <div className="max-h-32 overflow-y-auto space-y-0.5">
                        {scrapeLiveNumbers.slice(0, 15).map((c, i) => (
                          <div key={i} className="flex items-center justify-between text-xs py-0.5 animate-pulse">
                            <span className="text-green-400 font-mono">{c.phone}</span>
                            <span className="text-slate-500 truncate ml-3">{c.company || c.source}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Results */}
                  {scrapeResults && !scraping && (
                    <div className="bg-black/30 rounded-2xl p-6 border border-white/5 space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-green-400">✅ Found {scrapeResults.length} phone numbers</p>
                        {scrapeProgress.status === 'done' && scrapeProgress.engine && (
                          <span className="text-[10px] text-slate-500">via {scrapeProgress.engine}</span>
                        )}
                      </div>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {scrapeResults.slice(0, 30).map((c, i) => (
                          <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-white/5">
                            <span className="text-slate-300 font-mono">{c.phone}</span>
                            <span className="text-slate-500">{c.company || c.source}</span>
                          </div>
                        ))}
                        {scrapeResults.length > 30 && <p className="text-xs text-slate-500">...and {scrapeResults.length - 30} more</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        <select id="scrape-label-select" onChange={(e) => { if (e.target.value === '__new__') { setShowLabelModal(true); e.target.value = ''; } }}
                          className="bg-black/30 border border-white/10 rounded-xl p-2 text-sm flex-1">
                          <option value="">No label</option>
                          {labels.map(l => <option key={l.id} value={l.id}>⬤ {l.name}</option>)}
                          <option value="__new__">＋ Create new label...</option>
                        </select>
                        <button onClick={() => importScrapeResults(document.getElementById('scrape-label-select').value || null)}
                          className="px-6 py-2 bg-whatsapp-light/20 text-whatsapp-light border border-whatsapp-light/30 rounded-xl font-bold text-sm">
                          + Save All
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* BOT CONTACTS SOURCE */}
              {contactSource === 'bot' && (
                <div className="glass p-8 rounded-[2rem] border-white/5 space-y-6">
                  <h3 className="text-lg font-bold flex items-center space-x-2"><i className="fas fa-robot text-blue-400"></i><span>Bot Contacts</span></h3>
                  <p className="text-sm text-slate-400">Fetch customers who messaged your WhatsApp bot. Contacts are pulled from your business account automatically.</p>
                  <div className="bg-black/20 rounded-xl p-4 border border-white/5 flex items-center space-x-3">
                    <i className="fas fa-store text-whatsapp-light"></i>
                    <div>
                      <p className="text-sm font-bold">{businesses.find(b => b.id === activeBusiness)?.name || 'Your Business'}</p>
                      <p className="text-[10px] text-slate-500">ID: {activeBusiness}</p>
                    </div>
                  </div>

                  {/* Time Filter */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-bold">Filter:</span>
                    {[
                      { id: 'all', label: 'All Contacts' },
                      { id: '30days', label: 'Last 30 Days' },
                      { id: '7days', label: 'Last 7 Days' },
                    ].map(f => (
                      <button key={f.id} onClick={() => setBotTimeFilter(f.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${botTimeFilter === f.id ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'}`}>
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <button onClick={fetchBotContacts} disabled={fetchingBot}
                    className="px-8 py-3 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-xl font-bold text-sm hover:bg-blue-500/30 disabled:opacity-50">
                    {fetchingBot ? <><i className="fas fa-circle-notch fa-spin mr-2"></i>Fetching...</> : <><i className="fas fa-download mr-2"></i>Fetch Bot Contacts</>}
                  </button>

                  {botResults && (
                    <div className="bg-black/30 rounded-2xl p-6 border border-white/5 space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-green-400">✅ Found {botResults.all.length} contacts</p>
                        {botResults.duplicates > 0 && (
                          <p className="text-xs text-amber-400 bg-amber-500/10 px-2 py-1 rounded-lg">⚠️ {botResults.duplicates} already saved (skipped)</p>
                        )}
                      </div>

                      {botResults.new.length === 0 ? (
                        <p className="text-sm text-slate-400">All contacts from this period are already saved. No new numbers to import.</p>
                      ) : (
                        <>
                          <p className="text-xs text-slate-400">{botResults.new.length} new contacts to save:</p>
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {botResults.new.slice(0, 20).map((c, i) => (
                              <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-white/5">
                                <span className="text-slate-300 font-mono">{c.phone}</span>
                                <span className="text-slate-500">{c.name || 'Bot User'}</span>
                              </div>
                            ))}
                            {botResults.new.length > 20 && <p className="text-xs text-slate-500">...and {botResults.new.length - 20} more</p>}
                          </div>

                          {/* Label Assignment Section */}
                          <div className="bg-black/20 rounded-xl p-4 border border-white/5 space-y-3">
                            <p className="text-xs font-bold text-slate-400 uppercase">Assign a label before saving</p>
                            <div className="flex items-center gap-3">
                              <select id="bot-label-select" onChange={(e) => { if (e.target.value === '__new__') { setShowLabelModal(true); e.target.value = ''; } }}
                                className="bg-black/30 border border-white/10 rounded-xl p-2.5 text-sm flex-1">
                                <option value="">No label</option>
                                {labels.map(l => <option key={l.id} value={l.id}>⬤ {l.name}</option>)}
                                <option value="__new__">＋ Create new label...</option>
                              </select>
                              <button onClick={() => {
                                const sel = document.getElementById('bot-label-select');
                                importBotResults(sel.value || null);
                              }}
                                className="px-6 py-2.5 bg-whatsapp-light/20 text-whatsapp-light border border-whatsapp-light/30 rounded-xl font-bold text-sm whitespace-nowrap">
                                + Save All Contacts
                              </button>
                            </div>
                            {labels.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {labels.map(l => (
                                  <button key={l.id} onClick={() => { document.getElementById('bot-label-select').value = l.id; }}
                                    className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-all cursor-pointer">
                                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.color }}></span>
                                    <span className="text-[10px] font-bold text-slate-300">{l.name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                            {labels.length === 0 && (
                              <p className="text-[11px] text-slate-500">No labels yet. Click "Create new label" above or <button onClick={() => setShowLabelModal(true)} className="text-purple-400 hover:underline">create one here</button> to organize your contacts.</p>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* MANAGE TAB - Labels & Contact List */}
              {contactSource === 'manage' && (
                <div className="space-y-6">
                  {/* Labels Management */}
                  <div className="glass p-8 rounded-[2rem] border-white/5 space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-bold flex items-center space-x-2"><i className="fas fa-tags text-purple-400"></i><span>Labels</span></h3>
                      <button onClick={() => setShowLabelModal(true)} className="px-4 py-2 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded-xl text-xs font-bold">+ New Label</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {labels.map(l => (
                        <div key={l.id} className="flex items-center space-x-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5">
                          <span className="w-3 h-3 rounded-full" style={{ background: l.color }}></span>
                          {editingLabelId === l.id ? (
                            <input value={editingLabelName} onChange={e => setEditingLabelName(e.target.value)}
                              onBlur={saveEditLabel} onKeyDown={e => { if (e.key === 'Enter') saveEditLabel(); if (e.key === 'Escape') setEditingLabelId(null); }}
                              autoFocus className="bg-transparent border-b border-white/30 text-xs font-bold w-20 outline-none" />
                          ) : (
                            <span className="text-xs font-bold cursor-pointer" onDoubleClick={() => startEditLabel(l)} title="Double-click to rename">{l.name}</span>
                          )}
                          <span className="text-[10px] text-slate-500">({contacts.filter(c => c.label === l.id).length})</span>
                          <button onClick={() => { const cnt = contacts.filter(c => c.label === l.id).length; if (window.confirm(`Delete label "${l.name}" and its ${cnt} contact(s)? This cannot be undone.`)) deleteLabel(l.id); }} className="text-red-400/50 hover:text-red-400 text-xs ml-1">×</button>
                        </div>
                      ))}
                      {labels.length === 0 && <p className="text-xs text-slate-500">No labels yet. Create one to organize contacts.</p>}
                    </div>
                  </div>

                  {/* Contact List */}
                  <div className="glass p-8 rounded-[2rem] border-white/5 space-y-4">
                    <div className="flex flex-wrap gap-3 items-center justify-between">
                      <h3 className="text-lg font-bold">All Contacts ({contacts.length})</h3>
                      <div className="flex gap-2">
                        <input value={contactSearch} onChange={e => setContactSearch(e.target.value)} placeholder="Search..." className="bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-xs w-40" />
                        <select value={filterLabel} onChange={e => setFilterLabel(e.target.value)} className="bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-xs">
                          <option value="all">All Labels</option>
                          <option value="">Unlabeled</option>
                          {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                        {contacts.length > 0 && (
                          <button onClick={() => { if(window.confirm('Delete ALL contacts?')) setContacts([]); }} className="px-3 py-2 bg-red-500/10 text-red-400 rounded-xl text-xs font-bold border border-red-500/20">Clear All</button>
                        )}
                      </div>
                    </div>

                    <div className="max-h-[400px] overflow-y-auto rounded-xl">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-[#0f172a]">
                          <tr className="text-slate-500 uppercase text-[10px]">
                            <th className="p-2 text-left">Phone</th>
                            <th className="p-2 text-left">Name</th>
                            <th className="p-2 text-left">Source</th>
                            <th className="p-2 text-left">Label</th>
                            <th className="p-2 text-left">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredContacts.slice(0, 100).map(c => {
                            const lbl = labels.find(l => l.id === c.label);
                            return (
                              <tr key={c.id} className="border-t border-white/5 hover:bg-white/5">
                                <td className="p-2 font-mono">{c.phone}</td>
                                <td className="p-2">{c.name || c.company || '-'}</td>
                                <td className="p-2"><span className="px-2 py-0.5 bg-white/5 rounded text-[10px]">{c.source || 'manual'}</span></td>
                                <td className="p-2">
                                  <select value={c.label || ''} onChange={e => setContactLabel([c.id], e.target.value || null)} className="bg-black/30 border border-white/10 rounded px-2 py-1 text-[10px]">
                                    <option value="">None</option>
                                    {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                                  </select>
                                </td>
                                <td className="p-2">
                                  <button onClick={() => deleteContacts([c.id])} className="text-red-400/60 hover:text-red-400 text-xs">🗑️</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {filteredContacts.length > 100 && <p className="text-xs text-slate-500 p-3">Showing first 100 of {filteredContacts.length}</p>}
                      {filteredContacts.length === 0 && <p className="text-xs text-slate-500 p-4 text-center">No contacts found.</p>}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* BROADCAST TAB */}
          {activeTab === 'broadcast' && (
            <motion.div key="broadcast" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full max-w-4xl space-y-8">
              {/* Label Selection for Campaign */}
              {!isBroadcasting && (
                <>
                  <div className="glass p-8 rounded-[2rem] border-white/5 space-y-4">
                    <h3 className="text-lg font-bold">Target Audience</h3>
                    <p className="text-sm text-slate-400">Select labels to include in this campaign. Leave empty to send to ALL contacts.</p>
                    <div className="flex flex-wrap gap-2">
                      {labels.map(l => {
                        const isSelected = selectedLabels.includes(l.id);
                        const count = contacts.filter(c => c.label === l.id).length;
                        return (
                          <button key={l.id}
                            onClick={() => setSelectedLabels(prev => isSelected ? prev.filter(x => x !== l.id) : [...prev, l.id])}
                            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold border transition-all ${isSelected ? 'border-purple-400/50 bg-purple-500/20 text-purple-300' : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'}`}>
                            <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.color }}></span>
                            <span>{l.name}</span>
                            <span className="text-[10px] opacity-60">({count})</span>
                          </button>
                        );
                      })}
                      {labels.length === 0 && <p className="text-xs text-slate-500">No labels created yet. Go to Contacts → Manage to create labels.</p>}
                    </div>
                    <div className="bg-black/30 rounded-xl p-4 border border-white/5">
                      <p className="text-sm"><span className="text-whatsapp-light font-bold">{campaignContacts.length}</span> contacts will receive this campaign</p>
                    </div>
                  </div>

                  {/* Delay Settings */}
                  <div className="glass p-8 rounded-[2rem] border-white/5 grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                    <div>
                      <h3 className="text-lg font-bold mb-2">Anti-Ban Delay</h3>
                      <p className="text-sm text-slate-400">Random delay between messages (seconds)</p>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="flex-1 space-y-2">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Min</label>
                        <input type="number" value={delay.min} onChange={(e) => setDelay({...delay, min: parseInt(e.target.value)})} className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-center" />
                      </div>
                      <div className="flex-1 space-y-2">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Max</label>
                        <input type="number" value={delay.max} onChange={(e) => setDelay({...delay, max: parseInt(e.target.value)})} className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-center" />
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Broadcast Controls */}
              <div className="glass p-10 rounded-[2.5rem] border-white/5 flex flex-col items-center">
                <div className="w-full flex flex-col sm:flex-row items-center justify-between mb-8 gap-4">
                  <div>
                    <h2 className="text-2xl font-bold">Campaign Status</h2>
                    <p className="text-sm text-slate-400">Progress: {progress.current} / {progress.total}</p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {!isBroadcasting ? (
                      <button onClick={handleStartBroadcast}
                        className="px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest bg-whatsapp-light text-white shadow-xl shadow-whatsapp-light/20 hover:scale-105 active:scale-95 transition-all">
                        Launch Campaign
                      </button>
                    ) : (
                      <>
                        <button onClick={handlePauseBroadcast}
                          className={`px-6 py-4 rounded-2xl font-black text-xs uppercase flex items-center space-x-2 ${isPaused ? 'bg-amber-500 text-white' : 'bg-white/10 text-slate-400 border border-white/5'}`}>
                          <i className={`fas ${isPaused ? 'fa-play' : 'fa-pause'}`}></i>
                          <span>{isPaused ? 'Resume' : 'Pause'}</span>
                        </button>
                        <button onClick={handleStopBroadcast}
                          className="px-6 py-4 rounded-2xl font-black text-xs uppercase bg-red-500/10 text-red-500 border border-red-500/20 flex items-center space-x-2">
                          <i className="fas fa-stop"></i><span>Stop</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden mb-8 border border-white/5">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${(progress.current / (progress.total || 1)) * 100}%` }}
                    className="h-full bg-gradient-to-r from-whatsapp-light to-whatsapp-teal shadow-[0_0_15px_rgba(37,211,102,0.5)]"></motion.div>
                </div>

                {/* Activity Log */}
                <div className="w-full">
                  <h4 className="text-xs font-bold text-slate-500 mb-4 uppercase flex items-center space-x-2"><i className="fas fa-terminal"></i><span>Activity Log</span></h4>
                  <div className="bg-black/50 border border-white/5 rounded-2xl p-6 h-64 overflow-y-auto font-mono text-[11px] space-y-1">
                    {progress.logs.map((log, i) => (
                      <div key={i} className={`${log.includes('✅') ? 'text-green-400' : log.includes('❌') ? 'text-red-400' : 'text-slate-400'}`}>{log}</div>
                    ))}
                    {progress.logs.length === 0 && <p className="text-slate-600">Waiting for campaign to start...</p>}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </main>

      {/* Subscription Expired Popup */}
      {isExpired && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[200]">
          <div className="bg-[#1e293b] rounded-3xl p-10 w-full max-w-md border border-red-500/20 text-center space-y-6">
            <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center text-red-400 text-4xl mx-auto">
              <i className="fas fa-calendar-xmark"></i>
            </div>
            <h2 className="text-xl font-bold text-red-400">Subscription Expired</h2>
            <p className="text-sm text-slate-300">Your subscription has expired. Please renew to continue using the CRM dashboard.</p>
            <div className="bg-black/30 rounded-xl p-4 border border-white/5">
              <p className="text-xs text-slate-400">Business: <span className="font-bold text-white">{activeBiz?.name}</span></p>
              {activeBiz?.nextDue && <p className="text-xs text-slate-500 mt-1">Due date: {new Date(activeBiz.nextDue).toLocaleDateString()}</p>}
            </div>
            <p className="text-xs text-slate-400">Contact your administrator to renew your subscription.</p>
            <div className="flex gap-3">
              <a href="https://wa.me/94760216497" target="_blank" rel="noopener noreferrer"
                className="flex-1 py-3 bg-whatsapp-light/20 text-whatsapp-light rounded-xl font-bold text-sm border border-whatsapp-light/30 flex items-center justify-center space-x-2">
                <i className="fab fa-whatsapp"></i><span>Contact Support</span>
              </a>
              <button onClick={handleAuthLogout} className="flex-1 py-3 bg-white/5 rounded-xl font-bold text-sm border border-white/10">Logout</button>
            </div>
          </div>
        </div>
      )}

      {/* New Label Modal */}
      {showLabelModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]" onClick={() => setShowLabelModal(false)}>
          <div className="bg-[#1e293b] rounded-3xl p-8 w-full max-w-sm border border-white/10 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Create Label</h3>
            <div>
              <label className="text-[10px] text-slate-500 font-bold uppercase">Label Name</label>
              <input value={newLabelName} onChange={e => setNewLabelName(e.target.value)} autoFocus
                className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-sm mt-1" placeholder="e.g., VIP Clients, Hot Leads" />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 font-bold uppercase">Color</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {LABEL_COLORS.map(c => (
                  <button key={c} onClick={() => setNewLabelColor(c)}
                    className={`w-8 h-8 rounded-full border-2 ${newLabelColor === c ? 'border-white scale-110' : 'border-transparent'}`}
                    style={{ background: c }}></button>
                ))}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowLabelModal(false)} className="flex-1 py-3 bg-white/5 rounded-xl font-bold text-sm border border-white/10">Cancel</button>
              <button onClick={addLabel} className="flex-1 py-3 bg-purple-500/20 text-purple-400 rounded-xl font-bold text-sm border border-purple-500/30">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
