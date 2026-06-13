/**
 * StreamVault — app.js
 * Netflix-style IPTV client
 * v2 — fixed M3U parser, CORS proxy fallback, improved player
 */

'use strict';

// =====================================================
// CONFIG
// =====================================================
const CONFIG = {
  playlistUrl: 'https://iptv-org.github.io/iptv/index.m3u',
  pageSize: 60,
  recentMax: 24,
  toastDuration: 2800,

  /**
   * CORS proxy options — tried in order when a direct stream fails.
   * These are free public proxies; for production host your own.
   * Format: (url) => proxied_url
   */
  corsProxies: [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://cors-anywhere.herokuapp.com/${u}`,
  ],
};

// =====================================================
// STATE
// =====================================================
const STATE = {
  allChannels: [],
  filtered: [],
  displayed: 0,
  favorites: new Set(),
  recent: [],
  view: 'home',
  search: '',
  category: '',
  country: '',
  darkMode: true,
  hlsInstance: null,
  currentChannel: null,
  proxyIndex: -1,   // -1 = direct, 0..n = proxy index
  intersectionObserver: null,
};

// =====================================================
// DOM REFS
// =====================================================
const $ = (id) => document.getElementById(id);
const DOM = {
  grid:             $('channelGrid'),
  loadingOverlay:   $('loadingOverlay'),
  errorState:       $('errorState'),
  emptyState:       $('emptyState'),
  channelCount:     $('channelCount'),
  searchBar:        $('searchBar'),
  searchInput:      $('searchInput'),
  searchClear:      $('searchClear'),
  searchToggleBtn:  $('searchToggleBtn'),
  categoryFilter:   $('categoryFilter'),
  countryFilter:    $('countryFilter'),
  darkModeToggle:   $('darkModeToggle'),
  themeIcon:        $('themeIcon'),
  retryBtn:         $('retryBtn'),
  clearFiltersBtn:  $('clearFiltersBtn'),
  sentinel:         $('loadMoreSentinel'),
  playerModal:      $('playerModal'),
  playerBackdrop:   $('playerBackdrop'),
  playerClose:      $('playerClose'),
  playerLogo:       $('playerLogo'),
  playerTitle:      $('playerTitle'),
  playerSub:        $('playerSub'),
  playerFavBtn:     $('playerFavBtn'),
  playerSpinner:    $('playerSpinner'),
  streamError:      $('streamError'),
  streamErrorMsg:   $('streamErrorMsg'),
  retryStreamBtn:   $('retryStreamBtn'),
  videoPlayer:      $('videoPlayer'),
  playPauseBtn:     $('playPauseBtn'),
  playPauseIcon:    $('playPauseIcon'),
  muteBtn:          $('muteBtn'),
  volumeSlider:     $('volumeSlider'),
  fullscreenBtn:    $('fullscreenBtn'),
  toast:            $('toast'),
};

// =====================================================
// INIT
// =====================================================
async function init() {
  loadPersistedState();
  applyTheme();
  bindGlobalEvents();
  setupIntersectionObserver();
  await fetchPlaylist();
}

// =====================================================
// PERSISTENCE
// =====================================================
function loadPersistedState() {
  try {
    STATE.favorites = new Set(JSON.parse(localStorage.getItem('sv_favorites') || '[]'));
    STATE.recent    = JSON.parse(localStorage.getItem('sv_recent') || '[]');
    STATE.darkMode  = localStorage.getItem('sv_dark') !== 'false';
  } catch (_) {}
}
function saveFavorites() { localStorage.setItem('sv_favorites', JSON.stringify([...STATE.favorites])); }
function saveRecent()    { localStorage.setItem('sv_recent',    JSON.stringify(STATE.recent)); }

function addToRecent(channel) {
  STATE.recent = STATE.recent.filter(c => c.url !== channel.url);
  STATE.recent.unshift({ ...channel, watchedAt: Date.now() });
  if (STATE.recent.length > CONFIG.recentMax) STATE.recent.length = CONFIG.recentMax;
  saveRecent();
}

// =====================================================
// THEME
// =====================================================
function applyTheme() {
  document.body.classList.toggle('light', !STATE.darkMode);
  DOM.themeIcon.textContent = STATE.darkMode ? '☀️' : '🌙';
}
function toggleTheme() {
  STATE.darkMode = !STATE.darkMode;
  localStorage.setItem('sv_dark', STATE.darkMode);
  applyTheme();
}

// =====================================================
// FETCH & PARSE M3U
// =====================================================
async function fetchPlaylist() {
  showLoading(true);
  showError(false);
  try {
    const res = await fetch(CONFIG.playlistUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    STATE.allChannels = parseM3U(text);
    onPlaylistLoaded();
  } catch (err) {
    console.error('Playlist fetch error:', err);
    showError(true);
    showLoading(false);
  }
}

/**
 * Robust M3U parser.
 *
 * M3U format:
 *   #EXTINF:-1 attr1="val1" attr2="val2",Display Name
 *   http://stream.url/path.m3u8
 *
 * Key fixes vs v1:
 *  - Splits on COMMA that follows the attributes section (not any comma)
 *  - Handles both single and double quotes around attribute values
 *  - Trims \r from Windows-style line endings
 *  - Falls back gracefully when attributes are missing
 */
function parseM3U(text) {
  const lines  = text.split('\n');
  const result = [];
  let meta     = null;

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim().replace(/\r$/, '');

    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      meta = parseExtInf(line);
      continue;
    }

    // URL line — must follow an #EXTINF
    if (meta && line && !line.startsWith('#')) {
      meta.url = line;
      if (meta.name && meta.url) result.push(meta);
      meta = null;
    }
  }

  return result;
}

/**
 * Parse a single #EXTINF line into a channel metadata object.
 *
 * Strategy:
 *   1. Find the LAST comma in the line — everything after it is the display name.
 *      (attribute values can contain commas, but the display-name separator
 *       is always the final comma on the line)
 *   2. The portion between "#EXTINF:-1 " and that comma contains key="value" pairs.
 */
function parseExtInf(line) {
  // Split at the last comma to get display name
  const lastComma  = line.lastIndexOf(',');
  const attrString = lastComma > 0 ? line.slice(0, lastComma)  : line;
  const displayName = lastComma > 0 ? line.slice(lastComma + 1).trim() : '';

  const get = (key) => {
    // Matches key="value" or key='value'  (case-insensitive, value may be empty)
    const re = new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, 'i');
    const m  = attrString.match(re);
    return m ? m[1].trim() : '';
  };

  const tvgName  = get('tvg-name');
  const tvgId    = get('tvg-id');
  const name     = tvgName || displayName || tvgId || 'Unknown Channel';
  const category = get('group-title') || 'Uncategorized';
  const country  = get('tvg-country').toUpperCase();
  const logo     = get('tvg-logo');
  const language = get('tvg-language');

  return { name, logo, country, language, category, url: '' };
}

// =====================================================
// AFTER LOAD
// =====================================================
function onPlaylistLoaded() {
  showLoading(false);
  populateFilters();
  applyFilters();
}

function populateFilters() {
  const categories = [...new Set(
    STATE.allChannels.map(c => c.category).filter(c => c && c !== 'Uncategorized').sort()
  )];
  const countries = [...new Set(
    STATE.allChannels.map(c => c.country).filter(Boolean).sort()
  )];
  appendOptions(DOM.categoryFilter, categories);
  appendOptions(DOM.countryFilter,  countries);
}

function appendOptions(select, values) {
  values.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
}

// =====================================================
// FILTERING
// =====================================================
function applyFilters() {
  const q   = STATE.search.toLowerCase().trim();
  const cat = STATE.category;
  const ctr = STATE.country;

  let pool;
  if (STATE.view === 'favorites') {
    pool = STATE.allChannels.filter(c => STATE.favorites.has(c.url));
  } else if (STATE.view === 'recent') {
    const byUrl = new Map(STATE.allChannels.map(c => [c.url, c]));
    pool = STATE.recent.map(r => byUrl.get(r.url) || r).filter(Boolean);
  } else {
    pool = STATE.allChannels;
  }

  STATE.filtered = pool.filter(c => {
    if (q) {
      const hay = `${c.name} ${c.category} ${c.country} ${c.language}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (cat && c.category !== cat) return false;
    if (ctr && c.country  !== ctr) return false;
    return true;
  });

  STATE.displayed    = 0;
  DOM.grid.innerHTML = '';
  updateCountBadge();

  if (STATE.filtered.length === 0) {
    showEmpty(true);
  } else {
    showEmpty(false);
    renderNextBatch();
  }
}

function updateCountBadge() {
  const n = STATE.filtered.length;
  DOM.channelCount.textContent = n === 0
    ? 'No channels'
    : `${n.toLocaleString()} channel${n !== 1 ? 's' : ''}`;
}

// =====================================================
// RENDERING
// =====================================================
function renderNextBatch() {
  const batch = STATE.filtered.slice(STATE.displayed, STATE.displayed + CONFIG.pageSize);
  if (!batch.length) return;
  const frag = document.createDocumentFragment();
  batch.forEach((ch, i) => frag.appendChild(createCard(ch, STATE.displayed + i)));
  DOM.grid.appendChild(frag);
  STATE.displayed += batch.length;
}

function createCard(channel, index) {
  const isFav   = STATE.favorites.has(channel.url);
  const initial = (channel.name || '?')[0].toUpperCase();
  const delay   = Math.min(index % CONFIG.pageSize, 20) * 18;

  const card = document.createElement('article');
  card.className = 'channel-card';
  card.setAttribute('role', 'listitem');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Watch ${channel.name}`);
  card.style.animationDelay = `${delay}ms`;

  // Category display — never show "Uncategorized" if we have nothing
  const catLabel = (channel.category && channel.category !== 'Uncategorized')
    ? escHtml(channel.category) : '';

  card.innerHTML = `
    <div class="card-thumb">
      ${channel.logo
        ? `<img class="card-logo"
               src="${escHtml(channel.logo)}"
               alt="${escHtml(channel.name)} logo"
               loading="lazy"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="card-logo-placeholder" style="${channel.logo ? 'display:none' : ''}">${initial}</div>
      <div class="card-overlay"></div>
      <span class="live-badge" aria-label="Live">LIVE</span>
      <div class="card-play" aria-hidden="true"><div class="card-play-icon">▶</div></div>
      <button class="card-fav-btn ${isFav ? 'active' : ''}"
              aria-label="${isFav ? 'Remove from' : 'Add to'} favorites"
              data-url="${escHtml(channel.url)}"
              title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
        ${isFav ? '❤' : '♡'}
      </button>
    </div>
    <div class="card-info">
      <span class="card-name" title="${escHtml(channel.name)}">${escHtml(channel.name)}</span>
      <span class="card-meta">
        ${channel.country
          ? `<span class="card-country">${escHtml(channel.country)}</span>
             ${catLabel ? '<span class="card-meta-dot">·</span>' : ''}`
          : ''}
        ${catLabel ? `<span class="card-category">${catLabel}</span>` : ''}
      </span>
    </div>`;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-fav-btn')) return;
    openPlayer(channel);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlayer(channel); }
  });

  card.querySelector('.card-fav-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(channel, e.currentTarget);
  });

  return card;
}

// =====================================================
// FAVORITES
// =====================================================
function toggleFavorite(channel, btnEl) {
  const url   = channel.url;
  const isFav = STATE.favorites.has(url);
  if (isFav) {
    STATE.favorites.delete(url);
    showToast('Removed from favorites');
  } else {
    STATE.favorites.add(url);
    showToast('Added to favorites ❤');
  }
  saveFavorites();

  if (btnEl) {
    const nowFav = STATE.favorites.has(url);
    btnEl.classList.toggle('active', nowFav);
    btnEl.textContent = nowFav ? '❤' : '♡';
    btnEl.setAttribute('aria-label', `${nowFav ? 'Remove from' : 'Add to'} favorites`);
  }

  if (STATE.currentChannel?.url === url) syncPlayerFavBtn();
}

function syncPlayerFavBtn() {
  const isFav = STATE.favorites.has(STATE.currentChannel?.url);
  DOM.playerFavBtn.classList.toggle('active', isFav);
  DOM.playerFavBtn.textContent = isFav ? '❤' : '♡';
}

// =====================================================
// PLAYER — open
// =====================================================
function openPlayer(channel) {
  STATE.currentChannel = channel;
  STATE.proxyIndex     = -1;   // start with direct attempt
  addToRecent(channel);

  // Header info
  DOM.playerTitle.textContent = channel.name || 'Unknown Channel';

  // Fix: show category properly, never "undefined"
  const parts = [channel.category, channel.country].filter(
    p => p && p !== 'Uncategorized' && p !== 'undefined'
  );
  DOM.playerSub.textContent = parts.join(' · ') || 'Live TV';

  if (channel.logo) {
    DOM.playerLogo.src = channel.logo;
    DOM.playerLogo.style.display = '';
    DOM.playerLogo.onerror = () => { DOM.playerLogo.style.display = 'none'; };
  } else {
    DOM.playerLogo.style.display = 'none';
  }

  syncPlayerFavBtn();
  resetPlayerUI();

  DOM.playerModal.hidden = false;
  document.body.style.overflow = 'hidden';
  DOM.playerClose.focus();

  attemptStream(channel.url);
}

function resetPlayerUI() {
  DOM.streamError.hidden    = true;
  DOM.playerSpinner.classList.remove('hidden');
  DOM.playPauseIcon.textContent = '⏸';
}

// =====================================================
// PLAYER — stream loading with proxy fallback
// =====================================================

/**
 * Attempt to load a stream URL.
 * On failure, automatically tries each CORS proxy in CONFIG.corsProxies.
 */
function attemptStream(originalUrl) {
  const url = resolveUrl(originalUrl);
  console.log(`[Player] Trying (proxy ${STATE.proxyIndex}):`, url);
  loadStream(url, originalUrl);
}

/** Apply the current proxy (or none) to a URL */
function resolveUrl(originalUrl) {
  if (STATE.proxyIndex < 0) return originalUrl;
  return CONFIG.corsProxies[STATE.proxyIndex](originalUrl);
}

/** Try the next proxy, or give up */
function tryNextProxy() {
  const ch = STATE.currentChannel;
  if (!ch) return;

  STATE.proxyIndex++;
  if (STATE.proxyIndex < CONFIG.corsProxies.length) {
    resetPlayerUI();
    attemptStream(ch.url);
  } else {
    // All proxies exhausted
    handleStreamError(
      'Stream unavailable',
      'This channel may be offline, geo-restricted, or blocked by your browser.'
    );
  }
}

function loadStream(url, originalUrl) {
  destroyHls();
  const video    = DOM.videoPlayer;
  video.src      = '';
  video.load();

  const isHls = /\.m3u8(\?|$)/i.test(url) || /\.m3u8/i.test(originalUrl);

  if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
    // HLS.js path
    const hls = new Hls({
      enableWorker:     true,
      lowLatencyMode:   false,
      maxBufferLength:  30,
      xhrSetup(xhr) {
        xhr.withCredentials = false;
      },
    });
    STATE.hlsInstance = hls;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      console.warn('[HLS] error', data.type, data.details, data.fatal);
      if (data.fatal) {
        hls.destroy();
        STATE.hlsInstance = null;
        tryNextProxy();
      }
    });

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari / iOS)
    video.src = url;
    video.play().catch(() => tryNextProxy());

  } else {
    // Direct src (MP4, etc.)
    video.src = url;
    video.play().catch(() => tryNextProxy());
  }

  // Attach events
  video.onwaiting = () => DOM.playerSpinner.classList.remove('hidden');
  video.onplaying = () => DOM.playerSpinner.classList.add('hidden');
  video.onpause   = () => { DOM.playPauseIcon.textContent = '▶'; };
  video.onplay    = () => { DOM.playPauseIcon.textContent = '⏸'; };
  video.onerror   = () => tryNextProxy();

  // Stall detection — if nothing happens in 12s, try next proxy
  clearStreamTimeout();
  STATE._streamTimeout = setTimeout(() => {
    if (video.readyState < 2) {   // HAVE_CURRENT_DATA
      console.warn('[Player] Stall timeout — trying next proxy');
      tryNextProxy();
    }
  }, 12000);

  video.onplaying = () => {
    clearStreamTimeout();
    DOM.playerSpinner.classList.add('hidden');
  };
}

function clearStreamTimeout() {
  if (STATE._streamTimeout) { clearTimeout(STATE._streamTimeout); STATE._streamTimeout = null; }
}

function handleStreamError(title = 'Stream unavailable', detail = '') {
  clearStreamTimeout();
  DOM.playerSpinner.classList.add('hidden');
  DOM.streamError.hidden = false;
  if (DOM.streamErrorMsg) DOM.streamErrorMsg.textContent = detail || title;
}

function destroyHls() {
  clearStreamTimeout();
  if (STATE.hlsInstance) {
    STATE.hlsInstance.destroy();
    STATE.hlsInstance = null;
  }
}

function closePlayer() {
  destroyHls();
  const video = DOM.videoPlayer;
  video.pause();
  video.src = '';
  video.load();
  DOM.playerModal.hidden = true;
  document.body.style.overflow = '';
  STATE.currentChannel = null;
  if (STATE.view === 'recent') applyFilters();
}

// =====================================================
// PLAYER CONTROLS
// =====================================================
function setupPlayerControls() {
  const video = DOM.videoPlayer;

  DOM.playPauseBtn.addEventListener('click', () => {
    video.paused ? video.play().catch(() => {}) : video.pause();
  });

  DOM.muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    DOM.muteBtn.textContent = video.muted ? '🔇' : '🔊';
  });

  DOM.volumeSlider.addEventListener('input', () => {
    video.volume  = DOM.volumeSlider.value;
    video.muted   = video.volume === 0;
    DOM.muteBtn.textContent = video.muted ? '🔇' : '🔊';
  });

  DOM.fullscreenBtn.addEventListener('click', toggleFullscreen);

  DOM.playerFavBtn.addEventListener('click', () => {
    if (STATE.currentChannel) toggleFavorite(STATE.currentChannel, null);
  });

  DOM.playerClose.addEventListener('click', closePlayer);
  DOM.playerBackdrop.addEventListener('click', closePlayer);

  // Retry button inside stream error panel
  if (DOM.retryStreamBtn) {
    DOM.retryStreamBtn.addEventListener('click', () => {
      if (!STATE.currentChannel) return;
      STATE.proxyIndex = -1;
      resetPlayerUI();
      attemptStream(STATE.currentChannel.url);
    });
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    DOM.videoPlayer.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// =====================================================
// INTERSECTION OBSERVER (infinite scroll)
// =====================================================
function setupIntersectionObserver() {
  STATE.intersectionObserver = new IntersectionObserver(
    (entries) => { if (entries[0].isIntersecting) renderNextBatch(); },
    { rootMargin: '200px' }
  );
  STATE.intersectionObserver.observe(DOM.sentinel);
}

// =====================================================
// UI HELPERS
// =====================================================
function showLoading(on) { DOM.loadingOverlay.classList.toggle('hidden', !on); }
function showError(on)   { DOM.errorState.hidden   = !on; }
function showEmpty(on)   { DOM.emptyState.hidden    = !on; }

let toastTimer;
function showToast(msg) {
  DOM.toast.textContent = msg;
  DOM.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => DOM.toast.classList.remove('visible'), CONFIG.toastDuration);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// =====================================================
// GLOBAL EVENTS
// =====================================================
function bindGlobalEvents() {
  DOM.darkModeToggle.addEventListener('click', toggleTheme);

  DOM.searchToggleBtn.addEventListener('click', () => {
    const isOpen = DOM.searchBar.classList.toggle('open');
    DOM.searchBar.setAttribute('aria-hidden', String(!isOpen));
    if (isOpen) DOM.searchInput.focus();
    else { DOM.searchInput.value = ''; STATE.search = ''; applyFilters(); }
  });

  DOM.searchInput.addEventListener('input', debounce((e) => {
    STATE.search = e.target.value;
    applyFilters();
  }, 250));

  DOM.searchClear.addEventListener('click', () => {
    DOM.searchInput.value = '';
    STATE.search = '';
    applyFilters();
    DOM.searchInput.focus();
  });

  DOM.categoryFilter.addEventListener('change', (e) => { STATE.category = e.target.value; applyFilters(); });
  DOM.countryFilter.addEventListener('change',  (e) => { STATE.country  = e.target.value; applyFilters(); });

  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('active');
        b.removeAttribute('aria-current');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-current', 'page');
      STATE.view = btn.dataset.view;
      applyFilters();
    });
  });

  DOM.retryBtn.addEventListener('click', () => { showError(false); fetchPlaylist(); });
  DOM.clearFiltersBtn.addEventListener('click', () => {
    DOM.searchInput.value = '';
    DOM.categoryFilter.value = '';
    DOM.countryFilter.value  = '';
    STATE.search = STATE.category = STATE.country = '';
    applyFilters();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.playerModal.hidden) closePlayer();
  });

  setupPlayerControls();
}

// =====================================================
// PWA
// =====================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// =====================================================
// BOOT
// =====================================================
document.addEventListener('DOMContentLoaded', init);
