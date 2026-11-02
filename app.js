/* ============================================================
   SelamatKu — Deteksi & Evakuasi Bencana (Mobile PWA)
   Dependencies: Leaflet (CDN)
   APIs used:    BMKG, USGS, Overpass API, OSRM
   Features:     Offline, Notifications, Family Sharing,
                 History/Favorites, Wake Lock, Haptics
   ============================================================ */

// ── STATE ──────────────────────────────────────────────────────
const state = {
  userPos: null,
  map: null,
  userMarker: null,
  shelterMarkers: [],
  familyMarkers: [],
  routeLayer: null,
  zoneCircle: null,
  activeShelters: [],
  activeRoute: null,
  navIndex: 0,
  soundOn: true,
  notificationsOn: false,
  lastQuakeIds: new Set(),
  scannerActive: false,
};

// ── CONSTANTS ──────────────────────────────────────────────────
const BMKG_FEED_URL = 'https://data.bmkg.go.id/DATA/GEMPA/TELESEISMIC/REALTIME/feed.xml';
const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const OVERPASS_API  = 'https://overpass-api.de/api/interpreter';
const OSRM_API      = 'https://router.project-osrm.org/route/v1/foot/';
const SHELTER_RADIUS = 3000;

const SHELTER_ICONS = {
  hospital: '🏥', school: '🏫', police: '🚓',
  fire: '🚒', mosque: '🕌', church: '⛪', park: '🌳'
};
const SHELTER_LABELS = {
  hospital: 'Rumah Sakit', school: 'Sekolah / Gedung', police: 'Pos Polisi',
  fire: 'Damkar', mosque: 'Masjid', church: 'Gereja', park: 'Ruang Terbuka'
};

// ── LOCALSTORAGE HELPERS ───────────────────────────────────────
const LS_KEYS = {
  FAMILY:    'selamatku_family',
  FAVORITES: 'selamatku_favorites',
  HISTORY:   'selamatku_history',
  SETTINGS:  'selamatku_settings',
  POS:       'selamatku_pos',
};

function loadLS(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e) { return fallback; }
}
function saveLS(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) {}
}

// ── AUDIO & HAPTICS ────────────────────────────────────────────
let audioCtx = null;
function beep(freq = 880, dur = 0.15) {
  if (!state.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.start(); osc.stop(audioCtx.currentTime + dur);
  } catch(e) {}
}
function alarm() { [0,200,400].forEach(d => setTimeout(() => beep(660, .2), d)); }

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}
function hapticTap()      { vibrate(20); }
function hapticTurn()     { vibrate([50, 30, 50]); }
function hapticDanger()   { vibrate([200, 100, 200, 100, 200]); }

// ── WAKE LOCK ──────────────────────────────────────────────────
let wakeLockSentinel = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        console.log('Wake lock released');
      });
    }
  } catch(e) { console.warn('Wake Lock not available:', e); }
}
async function releaseWakeLock() {
  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch(e) {}
}

// ── NOTIFICATIONS ──────────────────────────────────────────────
// Detect if running inside Android WebView (APK)
const IS_WEBVIEW = /Android.*Version\/[\d.]+.*Mobile Safari/.test(navigator.userAgent)
  && !/Chrome\/[\d.]+ Mobile/.test(navigator.userAgent);

async function initNotifications() {
  const btn = document.getElementById('btn-notification');

  // In WebView (APK), hide notification button — use in-app alerts instead
  if (IS_WEBVIEW || !('Notification' in window)) {
    if (btn) btn.style.display = 'none';
    state.notificationsOn = false;
    return;
  }

  // Restore previous preference
  const settings = loadLS(LS_KEYS.SETTINGS, {});
  state.notificationsOn = settings.notificationsOn || false;
  updateNotifButton();

  if (state.notificationsOn && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      state.notificationsOn = false;
      saveLS(LS_KEYS.SETTINGS, { notificationsOn: false });
      updateNotifButton();
    }
  }
}

function toggleNotifications() {
  if (IS_WEBVIEW || !('Notification' in window)) {
    showInAppAlert('ℹ️ Info', 'Notifikasi system tidak tersedia di mode aplikasi.\nPeringatan gempa tetap tampil di dalam aplikasi dengan suara & getaran.');
    return;
  }

  if (!state.notificationsOn) {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') {
        state.notificationsOn = true;
        saveLS(LS_KEYS.SETTINGS, { notificationsOn: true });
        updateNotifButton();
        showTestNotification();
      } else {
        showInAppAlert('⚠️ Izin Ditolak', 'Izin notifikasi ditolak oleh browser.\nAnda tetap mendapat peringatan di dalam aplikasi.');
      }
    });
  } else {
    state.notificationsOn = false;
    saveLS(LS_KEYS.SETTINGS, { notificationsOn: false });
    updateNotifButton();
  }
}

function updateNotifButton() {
  const btn = document.getElementById('btn-notification');
  if (!btn) return;
  btn.textContent = state.notificationsOn ? '🔔' : '🔕';
  btn.classList.toggle('active', state.notificationsOn);
}

function showTestNotification() {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('🛡️ SelamatKu', {
      body: 'Notifikasi aktif! Anda akan mendapat peringatan gempa besar.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
    });
  }
}

/** Show an in-app alert modal (works everywhere including WebView) */
function showInAppAlert(title, message) {
  let overlay = document.getElementById('inapp-alert');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'inapp-alert';
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `<div class="modal" style="max-height:60vh">
      <div class="modal-header"><h2 id="inapp-title"></h2>
      <button class="icon-btn" onclick="document.getElementById('inapp-alert').classList.add('hidden')">✕</button></div>
      <div class="modal-body"><p id="inapp-msg" style="font-size:14px;line-height:1.7;color:var(--clr-text-2)"></p></div>
      <div class="modal-footer"><button class="btn-primary btn-full" onclick="document.getElementById('inapp-alert').classList.add('hidden')">OK</button></div>
    </div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('inapp-title').textContent = title;
  document.getElementById('inapp-msg').textContent = message;
  overlay.classList.remove('hidden');
}

/** Unified earthquake alert: uses system notification if available,
 *  otherwise falls back to in-app visual + sound + vibration */
function notifyEarthquake(quake) {
  const isMajor = quake.mag >= 6;
  const isModerate = quake.mag >= 5;
  if (!isMajor && !isModerate) return;

  // Dedup
  const quakeId = `${quake.lat.toFixed(3)},${quake.lng.toFixed(3)},${quake.time}`;
  if (state.lastQuakeIds.has(quakeId)) return;
  state.lastQuakeIds.add(quakeId);
  if (state.lastQuakeIds.size > 50) {
    state.lastQuakeIds = new Set([...state.lastQuakeIds].slice(-50));
  }

  const distText = state.userPos
    ? ` · Jarak: ${formatDist(haversineKm(state.userPos.lat, state.userPos.lng, quake.lat, quake.lng))}`
    : '';
  const title = `🌍 Gempa M${quake.mag}${isMajor ? ' ⚠️ BESAR' : ''}`;
  const body = `${quake.place || 'Lokasi tidak diketahui'}${distText}\n${timeAgo(quake.time)}`;

  // Try system notification first (browser only)
  if (!IS_WEBVIEW && 'Notification' in window &&
      Notification.permission === 'granted' && state.notificationsOn) {
    try {
      new Notification(title, {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: `quake-${quakeId}`,
        requireInteraction: isMajor,
      });
    } catch(e) {}
  }

  // ALWAYS show in-app alert for significant quakes
  showInAppAlert(title, body);

  // Sound + vibration always
  if (isMajor) {
    hapticDanger();
    alarm();
  } else {
    hapticTurn();
    beep(880, .2);
  }

  // Update status banner
  setStatus(isMajor ? 'danger' : 'warning',
    `Gempa M${quake.mag} terdeteksi`,
    quake.place || '');

  // Auto-trigger safety scan CTA after 2s
  selectedDisasterType = 'gempa';
  setTimeout(() => triggerAutoScan('gempa'), 2000);
}

// ── GEO MATH ───────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDist(km) {
  return km < 1 ? `${Math.round(km*1000)} m` : `${km.toFixed(1)} km`;
}
function formatDuration(sec) {
  const min = Math.round(sec / 60);
  return min < 1 ? '< 1 menit' : `± ${min} menit`;
}
function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1)   return 'Baru saja';
  if (min < 60)  return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr} jam lalu`;
  return `${Math.floor(hr/24)} hari lalu`;
}
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) +
         ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// ── MAP INIT ───────────────────────────────────────────────────
function initMap() {
  state.map = L.map('map').setView([-6.2, 106.8], 13);

  // Primary: OpenStreetMap (no API key needed)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(state.map);

  // Alternative dark theme (uncomment if you prefer dark map):
  // L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
  //   attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  //   maxZoom: 19
  // }).addTo(state.map);

  // Always start real-time GPS watch
  // If saved position exists, show it immediately while GPS loads
  const savedPos = loadLS(LS_KEYS.POS, null);
  if (savedPos && savedPos.lat != null) {
    state.userPos = savedPos;
    updateUserMarker();
    state.map.setView([savedPos.lat, savedPos.lng], 15);
    setStatus('info', 'Memuat posisi terakhir…',
      `Mencari GPS real-time — posisi sementara: ${savedPos.lat.toFixed(4)}, ${savedPos.lng.toFixed(4)}`);
    fetchEarthquakes();
    fetchNearbyShelters();
    checkTsunamiRisk();
  }

  // Start continuous GPS tracking regardless
  if (navigator.geolocation) {
    geoFirstFix = !state.userPos; // if we have saved pos, don't re-center on first fix
    startGeoWatch();
  } else {
    showManualPosModal('Browser tidak mendukung geolocation.');
  }
}

// ── AI SAFETY SCANNER ────────────────────────────────────────
let scannerStream = null;
let selectedDisasterType = 'gempa';

async function openSafetyScanner(disasterType) {
  const overlay = document.getElementById('scanner-overlay');
  if (!overlay) return;

  // Pre-select disaster type if provided
  if (disasterType) selectedDisasterType = disasterType;
  updateChipSelection();

  overlay.classList.remove('hidden');
  document.getElementById('scanner-loading').classList.add('hidden');
  document.getElementById('scanner-results').classList.add('hidden');

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const video = document.getElementById('scanner-video');
    video.srcObject = scannerStream;
    await video.play();
    document.getElementById('scanner-status').textContent = 'Kamera aktif';
  } catch (err) {
    console.error('Camera error:', err);
    document.getElementById('scanner-status').textContent = 'Kamera gagal';
    document.getElementById('scanner-hint').textContent =
      '⚠️ Tidak dapat mengakses kamera. Izinkan akses kamera di browser/settings.';
    document.getElementById('btn-capture').disabled = true;
  }
}

function closeSafetyScanner() {
  stopCamera();
  const overlay = document.getElementById('scanner-overlay');
  if (overlay) overlay.classList.add('hidden');
  state.scannerActive = false;
}

function stopCamera() {
  if (scannerStream) {
    scannerStream.getTracks().forEach(t => t.stop());
    scannerStream = null;
  }
  const video = document.getElementById('scanner-video');
  if (video) video.srcObject = null;
}

function updateChipSelection() {
  document.querySelectorAll('#scanner-disaster-types .chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.type === selectedDisasterType);
  });
}

function captureFrame() {
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');
  if (!video || !video.videoWidth) return null;

  // Cap at 800px for smaller payload
  const maxDim = 800;
  let w = video.videoWidth, h = video.videoHeight;
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}

async function analyzeScene(imageData) {
  const loadingEl = document.getElementById('scanner-loading');
  const resultsEl = document.getElementById('scanner-results');
  const hintEl = document.getElementById('scanner-hint');

  // Visual flash effect on capture
  const video = document.getElementById('scanner-video');
  if (video) {
    video.style.filter = 'brightness(2)';
    setTimeout(() => { if (video) video.style.filter = ''; }, 150);
  }

  loadingEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  if (hintEl) hintEl.textContent = '📤 Mengirim ke AI…';

  try {
    console.log('[Scanner] Sending image, size:', imageData.length, 'bytes');

    const resp = await fetch('/api/analyze-safety', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: imageData,
        disasterType: selectedDisasterType,
        context: state.userPos ? `Lokasi: ${state.userPos.lat.toFixed(4)}, ${state.userPos.lng.toFixed(4)}` : ''
      })
    });

    console.log('[Scanner] Response status:', resp.status);

    if (!resp.ok) {
      let errMsg = `Server error (${resp.status})`;
      try {
        const errBody = await resp.json();
        errMsg = errBody.error || errMsg;
      } catch(e) {}
      throw new Error(errMsg);
    }

    const result = await resp.json();
    console.log('[Scanner] Analysis result:', result);
    renderSafetyResult(result);

  } catch (err) {
    console.error('[Scanner] Error:', err);
    loadingEl.classList.add('hidden');
    if (hintEl) hintEl.textContent = 'Arahkan kamera ke sekitar Anda, lalu tekan tombol untuk capture';

    // Specific error messages
    let userMsg = err.message;
    if (err.message.includes('fetch') || err.message.includes('network')) {
      userMsg = 'Koneksi terputus. Periksa internet Anda.';
    } else if (err.message.includes('429')) {
      userMsg = 'Terlalu banyak scan. Tunggu 1 menit lalu coba lagi.';
    } else if (err.message.includes('ANTHROPIC_API_KEY') || err.message.includes('not configured')) {
      userMsg = 'Server belum dikonfigurasi. Hubungi developer.';
    }

    showInAppAlert('❌ Gagal Analisis', userMsg + '\n\nTips:\n• Pastikan koneksi internet aktif\n• Gambar tidak terlalu gelap\n• Coba lagi dalam beberapa detik');
  }
}

function renderSafetyResult(result) {
  const loadingEl = document.getElementById('scanner-loading');
  const resultsEl = document.getElementById('scanner-results');
  loadingEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  // Risk badge
  const badges = { safe: '✅', caution: '⚠️', danger: '🚨' };
  document.getElementById('result-risk-badge').textContent = badges[result.riskLevel] || '⚠️';

  // Summary
  document.getElementById('result-summary').textContent = result.summary || '';

  // Recommendations
  const recsEl = document.getElementById('result-recs');
  recsEl.innerHTML = '';
  (result.recommendations || []).sort((a, b) => a.priority - b.priority).forEach(rec => {
    const pClass = `p${Math.min(rec.priority, 3)}`;
    recsEl.innerHTML += `<div class="rec-card ${pClass}">
      <span class="rec-priority">${rec.priority}</span>
      <div class="rec-text"><strong>${esc(rec.action)}</strong><span>📍 ${esc(rec.location)}</span></div>
    </div>`;
  });

  // Danger zones
  const dangersEl = document.getElementById('result-dangers');
  const dangerList = document.getElementById('result-danger-list');
  if (result.dangerZones && result.dangerZones.length > 0) {
    dangersEl.classList.remove('hidden');
    dangerList.innerHTML = result.dangerZones.map(z => `<li>${esc(z)}</li>`).join('');
  } else {
    dangersEl.classList.add('hidden');
  }

  // Confidence
  const conf = result.confidence != null ? Math.round(result.confidence * 100) : null;
  document.getElementById('result-confidence').textContent =
    conf ? `Confidence analisis: ${conf}%` : '';

  // Haptic feedback based on risk
  if (result.riskLevel === 'danger') hapticDanger();
  else hapticTurn();
}

function triggerAutoScan(disasterType) {
  const banner = document.getElementById('scan-cta-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
  // Auto-dismiss after 15s
  setTimeout(() => banner.classList.add('hidden'), 15000);
}

// Escape HTML helper
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ── LOCATION ─────────────────────────────────────────────────
let geoWatchId = null;
let geoRetryCount = 0;
const GEO_MAX_RETRIES = 5;

function requestLocation() {
  setStatus('info', 'Mengambil lokasi…', 'Mohon izinkan akses lokasi Anda.');

  if (!navigator.geolocation) {
    showManualPosModal('Browser tidak mendukung geolocation.\nMasukkan koordinat Anda secara manual:');
    return;
  }

  // Use watchPosition for real-time continuous tracking
  startGeoWatch();
}

function startGeoWatch() {
  if (geoWatchId !== null) return; // already watching

  geoWatchId = navigator.geolocation.watchPosition(
    onGeoSuccess,
    onGeoError,
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 10000  // accept cached position up to 10s old
    }
  );
}

function stopGeoWatch() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

/** Show a modal asking user to manually enter coordinates */
function showManualPosModal(reason) {
  let overlay = document.getElementById('manual-pos-overlay');
  if (overlay) overlay.remove();

  const saved = loadLS(LS_KEYS.POS, null);
  const defLat = saved ? saved.lat : -6.2;
  const defLng = saved ? saved.lng : 106.8;

  overlay = document.createElement('div');
  overlay.id = 'manual-pos-overlay';
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-header"><h2>📍 Lokasi Manual</h2></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--clr-text-2);margin-bottom:14px;line-height:1.6">${reason}</p>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Latitude</label>
        <input type="number" step="0.0001" id="manual-lat" value="${defLat}"
          class="form-input" placeholder="-6.2000">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Longitude</label>
        <input type="number" step="0.0001" id="manual-lng" value="${defLng}"
          class="form-input" placeholder="106.8000">
      </div>
      <p style="font-size:11px;color:var(--clr-text-3)">💡 Contoh Jakarta: Lat -6.2, Lng 106.8<br>Contoh Bandung: Lat -6.9, Lng 107.6</p>
    </div>
    <div class="modal-footer" style="gap:8px">
      <button class="btn-secondary btn-full" onclick="document.getElementById('manual-pos-overlay').classList.add('hidden')">Batal</button>
      <button class="btn-primary btn-full" id="btn-manual-save">Simpan</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  document.getElementById('btn-manual-save').addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('manual-lat').value);
    const lng = parseFloat(document.getElementById('manual-lng').value);
    if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      alert('Koordinat tidak valid!');
      return;
    }
    state.userPos = { lat, lng };
    saveLS(LS_KEYS.POS, state.userPos);
    overlay.classList.add('hidden');
    updateUserMarker();
    fetchEarthquakes();
    fetchNearbyShelters();
    checkTsunamiRisk();
    setStatus('safe', 'Lokasi diset manual', `Koordinat: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  });
}

function updateUserMarker() {
  if (!state.userPos) return;
  const { lat, lng } = state.userPos;
  if (state.userMarker) state.map.removeLayer(state.userMarker);
  state.userMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:18px;height:18px;border-radius:50%;
        background:#1a73e8;border:3px solid #fff;
        box-shadow:0 0 0 4px rgba(26,115,232,.3);
        animation:pulse-dot 2s infinite;"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9]
    })
  }).addTo(state.map);
  injectPulseCSS();
}

let geoFirstFix = true;

function onGeoSuccess(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;
  const accuracy = pos.coords.accuracy || 0;
  state.userPos = { lat, lng };
  saveLS(LS_KEYS.POS, state.userPos);
  updateUserMarker();

  // Only re-center map on first fix, then just update marker
  if (geoFirstFix) {
    geoFirstFix = false;
    geoRetryCount = 0;
    state.map.setView([lat, lng], 15);
    setStatus('safe', '📡 Lokasi real-time aktif',
      `Akurasi: ±${Math.round(accuracy)}m · Update otomatis`);
    fetchEarthquakes();
    fetchNearbyShelters();
    checkTsunamiRisk();
  } else {
    // Update status subtly to show live tracking
    const banner = document.getElementById('status-banner');
    if (banner && banner.classList.contains('banner-safe')) {
      document.getElementById('status-msg').textContent =
        `Live: ${lat.toFixed(5)}, ${lng.toFixed(5)} (±${Math.round(accuracy)}m)`;
    }
  }
}

function onGeoError(err) {
  geoRetryCount++;
  const msgs = {
    1: 'Izin lokasi ditolak di browser.',
    2: 'GPS tidak tersedia / sinyal lemah.',
    3: 'Menunggu sinyal GPS…'
  };
  const msg = msgs[err.code] || err.message;

  // Permission denied → stop watching, offer manual
  if (err.code === 1) {
    stopGeoWatch();
    if (IS_WEBVIEW) {
      showManualPosModal(`${msg}\n\nDi mode aplikasi, GPS dibatasi.\nMasukkan koordinat Anda:`);
    } else {
      setStatus('warning', 'Izin lokasi diperlukan',
        msg + '\nBuka Settings → Site Permissions → Location → Allow');
    }
    return;
  }

  // Timeout / unavailable → retry up to max, then fallback
  if (geoRetryCount >= GEO_MAX_RETRIES && !state.userPos) {
    stopGeoWatch();
    setStatus('warning', 'GPS belum terdeteksi',
      'Mencoba ulang otomatis… atau gunakan ✏️ untuk set manual');
    // Offer manual as secondary option (not blocking)
    setTimeout(() => {
      if (!state.userPos) {
        showManualPosModal('GPS belum memberikan posisi setelah beberapa percobaan.\n\nAnda bisa tunggu (akan terus retry) atau set manual:');
      }
    }, 5000);
  } else {
    // Still retrying — show progress
    if (!state.userPos) {
      setStatus('info', 'Mencari sinyal GPS…',
        `Percobaan ${geoRetryCount}/${GEO_MAX_RETRIES} — ${msg}`);
    }
  }
}

function injectPulseCSS() {
  if (document.getElementById('pulse-css')) return;
  const s = document.createElement('style');
  s.id = 'pulse-css';
  s.textContent = `@keyframes pulse-dot{0%{box-shadow:0 0 0 0 rgba(26,115,232,.5)}70%{box-shadow:0 0 0 12px rgba(26,115,232,0)}100%{box-shadow:0 0 0 0 rgba(26,115,232,0)}}`;
  document.head.appendChild(s);
}

// ── STATUS BANNER ──────────────────────────────────────────────
function setStatus(type, title, msg) {
  const banner = document.getElementById('status-banner');
  const icons  = { safe:'✅', warning:'⚠️', danger:'🚨', info:'ℹ️' };
  banner.className = `banner banner-${type}`;
  document.getElementById('status-icon').textContent  = icons[type];
  document.getElementById('status-title').textContent = title;
  document.getElementById('status-msg').textContent   = msg;
  if (type === 'danger') { alarm(); hapticDanger(); }
}

// ── EARTHQUAKE DATA ────────────────────────────────────────────
async function fetchEarthquakes() {
  const listEl = document.getElementById('disaster-list');
  listEl.innerHTML = '<div class="loading-state"><span class="spinner"></span>Memuat data gempa…</div>';

  let quakes = [];

  try {
    const resp = await fetch(BMKG_FEED_URL, { mode: 'cors' });
    if (resp.ok) {
      const xml = await resp.text();
      quakes = parseBMKG(xml);
    }
  } catch(e) { console.warn('BMKG failed:', e); }

  if (quakes.length === 0) {
    try {
      const resp = await fetch(USGS_FEED_URL);
      if (resp.ok) {
        const json = await resp.json();
        quakes = json.features.slice(0, 30).map(f => ({
          mag:       f.properties.mag,
          place:     f.properties.place,
          time:      f.properties.time,
          depth:     f.geometry.coordinates[2],
          lat:       f.geometry.coordinates[1],
          lng:       f.geometry.coordinates[0],
          tsunami:   false
        }));
      }
    } catch(e) { console.warn('USGS failed:', e); }
  }

  renderEarthquakes(quakes);

  // Notify for significant quakes
  quakes.forEach(q => {
    if (q.mag >= 5) notifyEarthquake(q);
  });
}

function parseBMKG(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'text/xml');
  const items  = doc.querySelectorAll('item');
  const results = [];

  items.forEach(item => {
    const text = item.querySelector('description')?.textContent || '';
    const magMatch   = text.match(/Mag[:\s]*([\d.]+)/i);
    const dateMatch  = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    const coordMatch = text.match(/#?(-?\d+\.?\d*)[, ](-?\d+\.?\d*)/);
    const depthMatch = text.match(/[Dd]epth[:\s]*(\d+)/i);
    const tsunamiFlag = /tsunami/i.test(text);

    if (magMatch && coordMatch && dateMatch) {
      results.push({
        mag:      parseFloat(magMatch[1]),
        place:    text.replace(/Mag[:\s]*[\d.]+,\s*/i, '').replace(/Depth:.*/, '').trim(),
        time:     dateMatch[1] + 'Z',
        depth:    depthMatch ? parseInt(depthMatch[1]) : null,
        lat:      parseFloat(coordMatch[1]),
        lng:      parseFloat(coordMatch[2]),
        tsunami:  tsunamiFlag
      });
    }
  });
  return results.slice(0, 30);
}

function renderEarthquakes(quakes) {
  const listEl = document.getElementById('disaster-list');
  if (!quakes.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🌍</span>Tidak ada data gempa saat ini.<br>Sumber data mungkin sedang offline.</div>';
    return;
  }

  const sorted = [...quakes].sort((a,b) => b.mag - a.mag);
  listEl.innerHTML = sorted.map(q => {
    const level  = q.mag >= 6 ? 'high' : q.mag >= 4 ? 'medium' : 'low';
    const dist   = state.userPos ? haversineKm(state.userPos.lat, state.userPos.lng, q.lat, q.lng) : null;
    const tsunamiBadge = q.tsunami ? ' <span style="color:var(--clr-danger);font-weight:700;">🌊 TSUNAMI</span>' : '';
    return `
      <div class="disaster-card ${level}">
        <div class="disaster-card-header">
          <span class="disaster-type">🌍 Gempa M${q.mag}${tsunamiBadge}</span>
          <span class="disaster-time">${timeAgo(q.time)}</span>
        </div>
        <p class="disaster-meta">
          ${q.place || '—'}
          ${q.depth != null ? `<br>Dalaman: ${q.depth} km` : ''}
        </p>
        ${dist != null ? `<p class="disaster-distance">📍 Jarak dari Anda: ${formatDist(dist)}</p>` : ''}
      </div>`;
  }).join('');
}

// ── TSUNAMI RISK CHECK ─────────────────────────────────────────
function checkTsunamiRisk() {
  fetchEarthquakes().then(() => {
    const listEl = document.getElementById('disaster-list');
    const highQuakes = Array.from(listEl.querySelectorAll('.disaster-card.high'));
    if (highQuakes.length > 0) {
      setStatus('warning', 'Peringatan: Gempa kuat terdeteksi',
        'Perhatikan potensi gelombang tsunami. Pindahkan diri ke tempat tinggi.');
    }
  });
}

// ── SHELTERS (Overpass API) ────────────────────────────────────
async function fetchNearbyShelters() {
  const listEl = document.getElementById('shelter-list');
  listEl.innerHTML = '<div class="loading-state"><span class="spinner"></span>Mencari tempat aman…</div>';

  const { lat, lng } = state.userPos;
  const r = SHELTER_RADIUS;

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"hospital|clinic"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"~"hospital|clinic"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="school"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="school"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="police"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="police"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="fire_station"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="fire_station"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="place_of_worship"]["religion"="islam"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="place_of_worship"]["religion"="islam"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="place_of_worship"]["religion"="christian"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="place_of_worship"]["religion"="christian"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["leisure"="park"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["leisure"="park"](${lat-r},${lng-r},${lat+r},${lng+r});
    );
    out center tags;
  `;

  try {
    const form = new URLSearchParams({ data: query });
    const resp = await fetch(OVERPASS_API, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
    const json = await resp.json();

    const shelters = json.elements.map(el => {
      const lat2 = el.lat ?? el.center?.lat;
      const lng2 = el.lon ?? el.center?.lon;
      if (!lat2 || !lng2) return null;
      const type = classifyShelter(el.tags);
      return {
        id:   el.id,
        name: el.tags.name || SHELTER_LABELS[type] || 'Tempat Aman',
        type,
        lat:  lat2,
        lng:  lng2,
        dist: haversineKm(lat, lng, lat2, lng2)
      };
    }).filter(Boolean).sort((a,b) => a.dist - b.dist).slice(0, 20);

    state.activeShelters = shelters;
    renderShelters(shelters);
    drawShelterMarkers(shelters);

  } catch(e) {
    console.error('Shelter fetch error:', e);
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚠️</span>
        Gagal memuat data tempat aman.<br>
        <small>${e.message}<br>Coba lagi beberapa saat.</small>
      </div>`;
  }
}

function classifyShelter(tags) {
  if (!tags) return 'park';
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') return 'hospital';
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'fire_station') return 'fire';
  if (tags.amenity === 'place_of_worship') {
    if (tags.religion === 'islam') return 'mosque';
    return 'church';
  }
  return 'park';
}

// ── FAVORITES ──────────────────────────────────────────────────
function getFavorites() { return loadLS(LS_KEYS.FAVORITES, []); }
function isFavorite(shelterId) {
  return getFavorites().some(f => f.shelterId === shelterId);
}
function toggleFavorite(shelter) {
  let favs = getFavorites();
  const idx = favs.findIndex(f => f.shelterId === shelter.id);
  if (idx >= 0) {
    favs.splice(idx, 1);
    hapticTap();
  } else {
    favs.unshift({
      shelterId: shelter.id,
      name: shelter.name,
      type: shelter.type,
      lat: shelter.lat,
      lng: shelter.lng,
      addedAt: Date.now()
    });
    hapticTap();
    beep(880, .1);
  }
  saveLS(LS_KEYS.FAVORITES, favs);
  renderFavorites();
  // Re-render shelter list to update star icons
  const filter = document.getElementById('shelter-type').value;
  renderShelters(state.activeShelters, filter);
}

function removeFavorite(shelterId) {
  let favs = getFavorites().filter(f => f.shelterId !== shelterId);
  saveLS(LS_KEYS.FAVORITES, favs);
  renderFavorites();
}

function renderFavorites() {
  const favs = getFavorites();
  const listEl = document.getElementById('favorites-list');
  if (!favs.length) {
    listEl.innerHTML = `<div class="empty-state"><span class="empty-icon">⭐</span>Belum ada favorit.<br>Tekan ⭐ di tab Tempat Aman untuk menyimpan.</div>`;
    return;
  }
  listEl.innerHTML = favs.map(f => `
    <div class="fav-card">
      <span class="shelter-icon">${SHELTER_ICONS[f.type]}</span>
      <div class="fav-info">
        <div class="fav-name">${f.name}</div>
        <div class="fav-type">${SHELTER_LABELS[f.type]}</div>
      </div>
      <button class="remove-fav" onclick="removeFavorite(${f.shelterId})" title="Hapus favorit">✕</button>
    </div>
  `).join('');
}

// ── HISTORY ────────────────────────────────────────────────────
function addHistory(entry) {
  let history = loadLS(LS_KEYS.HISTORY, []);
  history.unshift({ ...entry, startedAt: Date.now() });
  // Keep max 50 entries
  if (history.length > 50) history = history.slice(0, 50);
  saveLS(LS_KEYS.HISTORY, history);
  renderHistory();
}

function clearHistory() {
  if (!confirm('Hapus semua riwayat evakuasi?')) return;
  saveLS(LS_KEYS.HISTORY, []);
  renderHistory();
}

function renderHistory() {
  const history = loadLS(LS_KEYS.HISTORY, []);
  const listEl = document.getElementById('history-list');
  if (!history.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🕐</span>Belum ada riwayat evakuasi.</div>';
    return;
  }
  listEl.innerHTML = history.map(h => `
    <div class="history-card">
      <div class="history-card-header">
        <span class="history-dest">${SHELTER_ICONS[h.destType] || '📍'} ${h.destName}</span>
        <span class="history-date">${formatDate(h.startedAt)}</span>
      </div>
      <div class="history-stats">
        <span>📏 ${formatDist(h.distanceKm)}</span>
        <span>⏱️ ${formatDuration(h.durationSec)}</span>
        ${h.completed ? '<span style="color:var(--clr-safe)">✓ Selesai</span>' : '<span style="color:var(--clr-warning)">● Berjalan</span>'}
      </div>
    </div>
  `).join('');
}

// ── RENDER SHELTERS (with favorite button) ─────────────────────
function renderShelters(shelters, filter = 'all') {
  const listEl = document.getElementById('shelter-list');
  const filtered = filter === 'all' ? shelters : shelters.filter(s => s.type === filter);

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🏥</span>Tidak ada tempat aman dalam radius 3 km.</div>';
    return;
  }

  listEl.innerHTML = filtered.map((s, i) => {
    const fav = isFavorite(s.id);
    return `
    <div class="shelter-card">
      <span class="shelter-icon">${SHELTER_ICONS[s.type]}</span>
      <div class="shelter-info">
        <div class="shelter-name">${s.name}</div>
        <div class="shelter-dist">📍 ${formatDist(s.dist)} dari Anda</div>
        <span class="shelter-type-badge">${SHELTER_LABELS[s.type]}</span>
      </div>
      <div class="shelter-actions">
        <button class="fav-btn ${fav ? 'active' : ''}" onclick="toggleFavorite({id:${s.id},name:'${s.name.replace(/'/g, "\\'")}',type:'${s.type}',lat:${s.lat},lng:${s.lng}})" title="Favorit">
          ${fav ? '★' : '☆'}
        </button>
        <button class="shelter-route-btn" onclick="navigateToShelter(${i}, '${filter}')">🧭 Rute</button>
      </div>
    </div>`;
  }).join('');

  state._filteredShelters = filtered;
}

function drawShelterMarkers(shelters) {
  state.shelterMarkers.forEach(m => state.map.removeLayer(m));
  state.shelterMarkers = [];

  shelters.forEach(s => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="font-size:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));">${SHELTER_ICONS[s.type]}</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
    const marker = L.marker([s.lat, s.lng], { icon })
      .bindPopup(`<strong>${s.name}</strong><br>${SHELTER_LABELS[s.type]}<br>📍 ${formatDist(s.dist)}`)
      .addTo(state.map);
    state.shelterMarkers.push(marker);
  });
}

// ── ROUTING (OSRM) ─────────────────────────────────────────────
async function getRoute(from, to) {
  const url = `${OSRM_API}${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
  const json = await resp.json();
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error('Rute tidak ditemukan');
  return json.routes[0];
}

function buildTurnByTurn(route) {
  return route.legs[0].steps.map(step => {
    const man = step.maneuver;
    const type = man.type;
    const mod  = man.modifier || '';
    const icons = {
      depart:         '🚶', arrive: '🏁',
      'turn': mod.includes('left') ? '⬅️' : '➡️',
      'new name':     '→',
      merge:          '🔀', 'on ramp': '⤴️', 'off ramp': '⤵️',
      fork:           '⑂', 'end of road': '🛑',
      continue:       '↑', roundabout: '🔄', rotary: '🔄'
    };
    const icon = icons[type] || '→';
    const street = step.narrative?.out || step.narrative?.name || '';
    const distTxt = step.distance < 100
      ? `${Math.round(step.distance)} m`
      : `${(step.distance/1000).toFixed(1)} km`;
    return { icon, street, distTxt, type, modifier: mod };
  });
}

// ── NAVIGATE TO SHELTER ────────────────────────────────────────
async function navigateToShelter(idx, filter) {
  const target = state._filteredShelters?.[idx] || state.activeShelters[idx];
  if (!target || !state.userPos) return;

  hapticTap();
  document.getElementById('evac-modal').classList.remove('hidden');
  document.getElementById('evac-target-info').innerHTML = `
    <strong>${SHELTER_ICONS[target.type]} ${target.name}</strong><br>
    ${SHELTER_LABELS[target.type]} · Jarak garis lurus: ${formatDist(target.dist)}
  `;
  document.getElementById('route-summary').classList.add('hidden');
  document.getElementById('turn-by-turn').innerHTML = '';
  document.getElementById('route-loading').classList.remove('hidden');
  document.getElementById('btn-start-nav').disabled = true;

  try {
    const route = await getRoute(state.userPos, { lat: target.lat, lng: target.lng });
    state.activeRoute = route;
    state.navIndex = 0;
    state._navTarget = target;
    state._navStart = Date.now();

    const summary = document.getElementById('route-summary');
    summary.classList.remove('hidden');
    document.getElementById('route-distance').textContent = formatDist(route.distance / 1000);
    document.getElementById('route-time').textContent     = formatDuration(route.duration);

    const tbt = buildTurnByTurn(route);
    document.getElementById('turn-by-turn').innerHTML = tbt.map(t => `
      <div class="turn-item">
        <span class="turn-icon">${t.icon}</span>
        <span class="turn-text">${t.street || 'Lanjut jalan'}</span>
        <span class="turn-dist">${t.distTxt}</span>
      </div>
    `).join('');

    drawRouteLine(route);
    document.getElementById('btn-start-nav').disabled = false;
    document.getElementById('route-loading').classList.add('hidden');

    const bounds = L.geoJSON(route.geometry).getBounds();
    state.map.fitBounds(bounds, { padding: [40, 40] });

  } catch(e) {
    document.getElementById('route-loading').innerHTML =
      `<div class="empty-state"><span class="empty-icon">⚠️</span>Gagal menghitung rute: ${e.message}</div>`;
  }
}

function drawRouteLine(route) {
  if (state.routeLayer) state.map.removeLayer(state.routeLayer);
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  state.routeLayer = L.polyline(coords, {
    color: '#1a73e8', weight: 5, opacity: .85,
    lineCap: 'round', lineJoin: 'round'
  }).addTo(state.map);

  const dest = coords[coords.length - 1];
  L.circleMarker(dest, {
    radius: 10, color: '#fff', fillColor: '#2e7d32', fillOpacity: 1, weight: 3
  }).addTo(state.map).bindPopup('🏁 Tujuan');
}

// ── START NAVIGATION MODE ──────────────────────────────────────
function startNavigation() {
  if (!state.activeRoute) return;
  hapticTap();
  document.getElementById('nav-overlay').classList.remove('hidden');
  document.getElementById('evac-modal').classList.add('hidden');
  updateNavInstruction();
  beep(880, .1);
  acquireWakeLock(); // Keep screen on during navigation
}

function updateNavInstruction() {
  const tbt = buildTurnByTurn(state.activeRoute);
  const step = tbt[state.navIndex];
  if (!step) {
    document.getElementById('nav-instruction').innerHTML = `
      <div class="nav-turn-icon">🏁</div>
      <div class="nav-street">Anda sudah tiba!</div>
      <div class="nav-distance">Selamat, Anda telah mencapai tempat aman.</div>`;
    document.getElementById('nav-progress-bar').style.width = '100%';
    // Log to history
    logEvacuationComplete();
    return;
  }
  document.getElementById('nav-instruction').innerHTML = `
    <div class="nav-turn-icon">${step.icon}</div>
    <div class="nav-street">${step.street || 'Lanjutkan'}</div>
    <div class="nav-distance">${step.distTxt}</div>`;

  const total = tbt.length;
  document.getElementById('nav-progress-bar').style.width =
    `${(state.navIndex / total) * 100}%`;
}

function advanceNavStep() {
  state.navIndex++;
  updateNavInstruction();
  hapticTurn();
  beep(660, .1);
}

function endNavigation() {
  document.getElementById('nav-overlay').classList.add('hidden');
  if (state.routeLayer) state.map.removeLayer(state.routeLayer);
  state.activeRoute = null;
  state.navIndex = 0;
  releaseWakeLock();
}

function logEvacuationComplete() {
  if (!state._navTarget || !state._navStart) return;
  const durationSec = Math.round((Date.now() - state._navStart) / 1000);
  addHistory({
    destName:  state._navTarget.name,
    destType:  state._navTarget.type,
    distanceKm: state._navTarget.dist,
    durationSec,
    completed: true
  });
  state._navTarget = null;
  state._navStart = null;
}

// ── FAMILY SHARING ─────────────────────────────────────────────
function getFamily() { return loadLS(LS_KEYS.FAMILY, []); }

function addFamilyMember() {
  const nameInput  = document.getElementById('member-name');
  const phoneInput = document.getElementById('member-phone');
  const name  = nameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!name)  { nameInput.focus(); return; }
  if (!phone || !/^0\d{8,12}$/.test(phone)) {
    phoneInput.focus();
    phoneInput.style.borderColor = 'var(--clr-danger)';
    setTimeout(() => phoneInput.style.borderColor = '', 2000);
    return;
  }

  let family = getFamily();
  // Prevent duplicate phone
  if (family.some(m => m.phone === phone)) {
    alert('Nomor HP sudah terdaftar.');
    return;
  }

  family.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name,
    phone,
    lastShared: null
  });
  saveLS(LS_KEYS.FAMILY, family);

  nameInput.value = '';
  phoneInput.value = '';
  hapticTap();
  beep(880, .1);
  renderFamily();
}

function removeFamilyMember(id) {
  if (!confirm('Hapus anggota keluarga ini?')) return;
  let family = getFamily().filter(m => m.id !== id);
  saveLS(LS_KEYS.FAMILY, family);
  renderFamily();
}

function sharePosition(memberId, method) {
  if (!state.userPos) {
    alert('Lokasi belum tersedia. Tunggu sampai posisi terdeteksi.');
    return;
  }

  const member = getFamily().find(m => m.id === memberId);
  if (!member) return;

  const { lat, lng } = state.userPos;
  const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
  const message = `📍 Posisi saya sekarang:\n${mapsUrl}\n\nKirim via SelamatKu — tolong dicek!`;

  // Normalize phone: 08xx → 628xx
  const intlPhone = '62' + member.phone.substring(1);

  if (method === 'sms') {
    window.location.href = `sms:+${intlPhone}?body=${encodeURIComponent(message)}`;
  } else if (method === 'wa') {
    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`, '_blank');
  }

  // Update last shared
  let family = getFamily();
  const m = family.find(x => x.id === memberId);
  if (m) {
    m.lastShared = Date.now();
    saveLS(LS_KEYS.FAMILY, family);
    renderFamily();
  }
  hapticTap();
}

function renderFamily() {
  const family = getFamily();
  const listEl = document.getElementById('family-list');

  if (!family.length) {
    listEl.innerHTML = `<div class="empty-state"><span class="empty-icon">👨‍👩‍👧👦</span>Belum ada anggota keluarga.<br>Tambahkan di atas untuk berbagi posisi saat darurat.</div>`;
    return;
  }

  listEl.innerHTML = family.map(m => {
    const initial = m.name.charAt(0).toUpperCase();
    const lastShare = m.lastShared ? formatDate(m.lastShared) : 'Belum pernah';
    return `
    <div class="member-card">
      <div class="member-header">
        <div class="member-avatar">${initial}</div>
        <div>
          <div class="member-name">${m.name}</div>
          <div class="member-phone">${m.phone}</div>
        </div>
      </div>
      <div class="member-last-share">Terakhir berbagi: ${lastShare}</div>
      <div class="member-actions">
        <button class="share-btn sms" onclick="sharePosition('${m.id}','sms')">📱 SMS</button>
        <button class="share-btn wa"  onclick="sharePosition('${m.id}','wa')">💬 WhatsApp</button>
        <button class="share-btn remove" onclick="removeFamilyMember('${m.id}')" title="Hapus">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ── BOTTOM NAV TAB SWITCHING ───────────────────────────────────
function initTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      hapticTap();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      document.getElementById(`tab-${tabId}`).classList.add('active');

      if (tabId === 'map') setTimeout(() => state.map.invalidateSize(), 50);
      if (tabId === 'history') { renderFavorites(); renderHistory(); }
      if (tabId === 'family')  renderFamily();
    });
  });

  // Handle deep link from manifest shortcuts (?tab=xxx)
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab) {
    const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (btn) btn.click();
  }
}

// ── PULL TO REFRESH ────────────────────────────────────────────
function initPullToRefresh() {
  let startY = 0;
  let pulling = false;

  document.addEventListener('touchstart', e => {
    if (window.scrollY <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const diff = e.touches[0].clientY - startY;
    const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
    const indicator = document.getElementById(`pull-indicator-${activeTab}`);
    if (indicator && diff > 50) {
      indicator.classList.add('active');
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!pulling) return;
    pulling = false;
    const diff = e.changedTouches[0].clientY - startY;
    const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
    const indicator = document.getElementById(`pull-indicator-${activeTab}`);

    if (indicator) indicator.classList.remove('active');

    if (diff > 80) {
      refreshCurrentTab(activeTab);
    }
  });
}

function refreshCurrentTab(tab) {
  const indicators = {
    disasters: 'pull-indicator-disasters',
    shelter:   'pull-indicator-shelter',
  };
  const ind = document.getElementById(indicators[tab]);
  if (ind) {
    ind.classList.add('refreshing');
    setTimeout(() => ind.classList.remove('refreshing'), 2000);
  }

  if (tab === 'disasters' && state.userPos) fetchEarthquakes();
  if (tab === 'shelter'   && state.userPos) fetchNearbyShelters();
  if (tab === 'map'       && state.userPos) {
    fetchEarthquakes();
    fetchNearbyShelters();
  }
}

// ── ONLINE/OFFLINE DETECTION ───────────────────────────────────
function initConnectivity() {
  const badge = document.createElement('div');
  badge.className = 'offline-badge';
  badge.id = 'offline-badge';
  badge.textContent = '📡 Mode Offline — Data terakhir ditampilkan';
  document.body.appendChild(badge);

  function update() {
    badge.classList.toggle('visible', !navigator.onLine);
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ── SERVICE WORKER REGISTRATION ────────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        console.log('SW registered, scope:', reg.scope);
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('New SW available and ready');
            }
          });
        });
      })
      .catch(err => console.warn('SW registration failed:', err));
  }
}

// ── PERIODIC BACKGROUND CHECK ──────────────────────────────────
function startPeriodicCheck() {
  // Check for new earthquakes every 5 minutes while page is visible
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.userPos) {
      fetchEarthquakes();
    }
  }, 5 * 60 * 1000);
}

// ── EVENT LISTENERS ────────────────────────────────────────────
function initEvents() {
  // Sound toggle
  document.getElementById('btn-sound').addEventListener('click', function() {
    state.soundOn = !state.soundOn;
    this.textContent = state.soundOn ? '🔊' : '🔇';
    this.classList.toggle('active', state.soundOn);
    hapticTap();
  });

  // Notification toggle
  document.getElementById('btn-notification').addEventListener('click', () => {
    hapticTap();
    toggleNotifications();
  });

  // Recenter — if no position yet, offer manual entry
  document.getElementById('btn-recenter').addEventListener('click', () => {
    hapticTap();
    if (state.userPos) {
      state.map.setView([state.userPos.lat, state.userPos.lng], 15);
    } else {
      requestLocation();
    }
  });

  // Change position manually
  const btnChangePos = document.getElementById('btn-change-pos');
  if (btnChangePos) btnChangePos.addEventListener('click', () => {
    hapticTap();
    showManualPosModal('Ubah koordinat posisi Anda:');
  });

  // ── AI Safety Scanner events ──
  const btnScanSafety = document.getElementById('btn-scan-safety');
  if (btnScanSafety) btnScanSafety.addEventListener('click', () => {
    hapticTap();
    state.scannerActive = true;
    openSafetyScanner();
  });

  const btnCloseScanner = document.getElementById('btn-close-scanner');
  if (btnCloseScanner) btnCloseScanner.addEventListener('click', closeSafetyScanner);

  const btnCapture = document.getElementById('btn-capture');
  if (btnCapture) btnCapture.addEventListener('click', async () => {
    hapticTap();
    const video = document.getElementById('scanner-video');

    // Check if video is actually playing
    if (!video || video.readyState < 2) {
      showInAppAlert('⚠️ Kamera belum siap', 'Tunggu sampai pratinjau kamera muncul, lalu coba lagi.');
      return;
    }

    const frame = captureFrame();
    if (!frame) {
      showInAppAlert('⚠️ Gagal capture', 'Kamera tidak menghasilkan gambar. Coba tutup dan buka lagi scanner.');
      return;
    }

    console.log('[Scanner] Frame captured:', frame.substring(0, 50), '... total', frame.length);
    btnCapture.disabled = true;
    analyzeScene(frame).finally(() => { btnCapture.disabled = false; });
  });

  const btnRescanAI = document.getElementById('btn-rescan-ai');
  if (btnRescanAI) btnRescanAI.addEventListener('click', () => {
    hapticTap();
    document.getElementById('scanner-results').classList.add('hidden');
    document.getElementById('scanner-loading').classList.add('hidden');
  });

  const btnCloseResults = document.getElementById('btn-close-results');
  if (btnCloseResults) btnCloseResults.addEventListener('click', closeSafetyScanner);

  // Disaster type chips
  document.querySelectorAll('#scanner-disaster-types .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedDisasterType = chip.dataset.type;
      updateChipSelection();
    });
  });

  // Auto-scan CTA button
  const btnAutoScan = document.getElementById('btn-auto-scan');
  if (btnAutoScan) btnAutoScan.addEventListener('click', () => {
    hapticTap();
    document.getElementById('scan-cta-banner').classList.add('hidden');
    state.scannerActive = true;
    openSafetyScanner(selectedDisasterType);
  });

  // Rescan
  document.getElementById('btn-rescan').addEventListener('click', () => {
    hapticTap();
    if (state.userPos) fetchNearbyShelters();
  });

  // Refresh earthquakes
  document.getElementById('btn-refresh-disaster').addEventListener('click', () => {
    hapticTap();
    fetchEarthquakes();
  });

  // Shelter filter
  document.getElementById('shelter-type').addEventListener('change', function() {
    renderShelters(state.activeShelters, this.value);
  });

  // Evacuate button (zone card)
  document.getElementById('btn-evacuate').addEventListener('click', () => {
    hapticTap();
    const hospitals = state.activeShelters.filter(s => s.type === 'hospital');
    const target = hospitals[0] || state.activeShelters[0];
    if (target) navigateToShelter(state.activeShelters.indexOf(target), 'all');
  });

  // Modal close
  document.getElementById('btn-close-evac').addEventListener('click', () => {
    document.getElementById('evac-modal').classList.add('hidden');
  });

  // Start nav
  document.getElementById('btn-start-nav').addEventListener('click', startNavigation);

  // End nav
  document.getElementById('btn-end-nav').addEventListener('click', () => {
    hapticTap();
    endNavigation();
  });

  // Keyboard: spacebar to advance nav step
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !document.getElementById('nav-overlay').classList.contains('hidden')) {
      e.preventDefault();
      advanceNavStep();
    }
  });

  // Add family member
  document.getElementById('btn-add-member').addEventListener('click', addFamilyMember);

  // Clear history
  document.getElementById('btn-clear-history').addEventListener('click', clearHistory);

  // Track position while navigating
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(pos => {
      if (!state.activeRoute) return;
      const cur = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const prev = state.userPos;
      if (prev && haversineKm(prev.lat, prev.lng, cur.lat, cur.lng) > 0.05) {
        advanceNavStep();
        state.userPos = cur;
      }
    }, null, { enableHighAccuracy: true });
  }
}

// ── BOOT ──────────────────────────────────────────────────────
// ── CLEAR OLD CACHES (one-time migration) ─────────────────────
async function clearOldCaches() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    const names = await caches.keys();
    for (const n of names) await caches.delete(n);
  } catch(e) {}
}

// ── BOOT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await clearOldCaches();
  registerServiceWorker();
  initMap();
  initTabs();
  initEvents();
  initNotifications();
  initPullToRefresh();
  initConnectivity();
  startPeriodicCheck();
  renderFavorites();
  renderHistory();
  renderFamily();
});
