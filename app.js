/**
 * StreamVault — app.js
 * Netflix-style IPTV client
 * Fetches, parses, filters, and plays M3U IPTV streams
 */

'use strict';

// =====================================================
// CONFIG
// =====================================================
const CONFIG = {
  playlistUrl: 'https://iptv-org.github.io/iptv/index.m3u',
  pageSize: 60,          // cards per infinite-scroll batch
  recentMax: 24,         // max recently watched entries
  toastDuration: 2800,   // ms
  logoFallback: true,    // show initial letter if logo fails
};

// =====================================================
// STATE
// =====================================================
const STATE = {
  allChannels: [],       // full parsed list
  filtered: [],          // after search/filter
  displayed: 0,          // how many rendered so far
  favorites: new Set(),
  recent: [],            // [{...channel, watchedAt}]
  view: 'home',          // 'home' | 'favorites' | 'recent'
  search: '',
  category: '',
  country: '',
  darkMode: true,
  hlsInstance: null,
  currentChannel: null,
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
    const favs = JSON.parse(localStorage.getItem('sv_favorites') || '[]');
    STATE.favorites = new Set(favs);
    STATE.recent = JSON.parse(localStorage.getItem('sv_recent') || '[]');
    STATE.darkMode = localStorage.getItem('sv_dark') !== 'false';
  } catch (_) { /* ignore */ }
}

function saveFavorites() {
  localStorage.setItem('sv_favorites', JSON.stringify([...STATE.favorites]));
}

function saveRecent() {
  localStorage.setItem('sv_recent', JSON.stringify(STATE.recent));
}

function addToRecent(channel) {
  // Remove duplicate, add to front
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
 * Parse M3U playlist text into an array of channel objects.
 * Handles #EXTINF tags and their attributes.
 */
function parseM3U(text) {
  const lines = text.split('\n');
  const channels = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      // Parse attributes from the tag line
      current = {
        name:     extractAttr(line, 'tvg-name') || extractAttr(line, 'tvg-id') || extractDisplayName(line),
        logo:     extractAttr(line, 'tvg-logo'),
        country:  (extractAttr(line, 'tvg-country') || '').toUpperCase(),
        language: extractAttr(line, 'tvg-language') || '',
        category: extractAttr(line, 'group-title') || 'Uncategorized',
        url:      '',
      };
      // Fallback to display name at end of EXTINF line
      if (!current.name) current.name = extractDisplayName(line);

    } else if (current && line && !line.startsWith('#')) {
      current.url = line;
      if (current.name && current.url) channels.push(current);
      current = null;
    }
  }
  return channels;
}

/** Extract a named attribute value from an EXTINF line */
function extractAttr(line, attr) {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = line.match(re);
  return m ? m[1].trim() : '';
}

/** Extract display name (after the last comma) from EXTINF line */
function extractDisplayName(line) {
  const idx = line.lastIndexOf(',');
  return idx !== -1 ? line.slice(idx + 1).trim() : '';
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
    STATE.allChannels.map(c => c.category).filter(Boolean).sort()
  )];
  const countries = [...new Set(
    STATE.allChannels.map(c => c.country).filter(Boolean).sort()
  )];

  appendOptions(DOM.categoryFilter, categories);
  appendOptions(DOM.countryFilter, countries);
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
// FILTERING & SEARCH
// =====================================================
function applyFilters() {
  const q = STATE.search.toLowerCase().trim();
  const cat = STATE.category;
  const ctr = STATE.country;

  let pool;

  if (STATE.view === 'favorites') {
    pool = STATE.allChannels.filter(c => STATE.favorites.has(c.url));
  } else if (STATE.view === 'recent') {
    // Maintain recent order
    const byUrl = new Map(STATE.allChannels.map(c => [c.url, c]));
    pool = STATE.recent
      .map(r => byUrl.get(r.url) || r)
      .filter(Boolean);
  } else {
    pool = STATE.allChannels;
  }

  STATE.filtered = pool.filter(c => {
    if (q && !c.name.toLowerCase().includes(q) &&
               !c.category.toLowerCase().includes(q) &&
               !c.country.toLowerCase().includes(q)) return false;
    if (cat && c.category !== cat) return false;
    if (ctr && c.country !== ctr) return false;
    return true;
  });

  STATE.displayed = 0;
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
  const total = STATE.filtered.length;
  DOM.channelCount.textContent = total === 0
    ? 'No channels'
    : `${total.toLocaleString()} channel${total !== 1 ? 's' : ''}`;
}

// =====================================================
// RENDERING
// =====================================================
function renderNextBatch() {
  const batch = STATE.filtered.slice(STATE.displayed, STATE.displayed + CONFIG.pageSize);
  if (batch.length === 0) return;

  const frag = document.createDocumentFragment();
  batch.forEach((ch, idx) => {
    frag.appendChild(createCard(ch, STATE.displayed + idx));
  });
  DOM.grid.appendChild(frag);
  STATE.displayed += batch.length;
}

function createCard(channel, index) {
  const isFav = STATE.favorites.has(channel.url);
  const initial = (channel.name || '?')[0].toUpperCase();

  const card = document.createElement('article');
  card.className = 'channel-card';
  card.setAttribute('role', 'listitem');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Watch ${channel.name}`);
  card.style.animationDelay = `${Math.min(index % CONFIG.pageSize, 20) * 18}ms`;

  card.innerHTML = `
    <div class="card-thumb">
      ${channel.logo
        ? `<img class="card-logo" src="${escHtml(channel.logo)}" alt="${escHtml(channel.name)} logo"
               loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''
      }
      <div class="card-logo-placeholder" style="${channel.logo ? 'display:none' : ''}">${initial}</div>
      <div class="card-overlay"></div>
      <span class="live-badge" aria-label="Live">LIVE</span>
      <div class="card-play" aria-hidden="true"><div class="card-play-icon">▶</div></div>
      <button class="card-fav-btn ${isFav ? 'active' : ''}"
              aria-label="${isFav ? 'Remove from' : 'Add to'} favorites"
              data-url="${escHtml(channel.url)}"
              title="Favorite">
        ${isFav ? '❤' : '♡'}
      </button>
    </div>
    <div class="card-info">
      <span class="card-name" title="${escHtml(channel.name)}">${escHtml(channel.name)}</span>
      <span class="card-meta">
        ${channel.country ? `<span>${channel.country}</span><span class="card-meta-dot">·</span>` : ''}
        <span class="card-category">${escHtml(channel.category)}</span>
      </span>
    </div>
  `;

  // Click card → play
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-fav-btn')) return; // handled below
    openPlayer(channel);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlayer(channel); }
  });

  // Fav button
  const favBtn = card.querySelector('.card-fav-btn');
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(channel, favBtn);
  });

  return card;
}

// =====================================================
// FAVORITES
// =====================================================
function toggleFavorite(channel, btnEl) {
  const url = channel.url;
  if (STATE.favorites.has(url)) {
    STATE.favorites.delete(url);
    showToast(`Removed from favorites`);
  } else {
    STATE.favorites.add(url);
    showToast(`Added to favorites ❤`);
  }
  saveFavorites();

  // Update card button
  if (btnEl) {
    const isFav = STATE.favorites.has(url);
    btnEl.classList.toggle('active', isFav);
    btnEl.textContent = isFav ? '❤' : '♡';
    btnEl.setAttribute('aria-label', `${isFav ? 'Remove from' : 'Add to'} favorites`);
  }

  // Update player fav button if open
  if (STATE.currentChannel?.url === url) {
    syncPlayerFavBtn();
  }
}

function syncPlayerFavBtn() {
  const isFav = STATE.favorites.has(STATE.currentChannel?.url);
  DOM.playerFavBtn.classList.toggle('active', isFav);
  DOM.playerFavBtn.textContent = isFav ? '❤' : '♡';
}

// =====================================================
// PLAYER
// =====================================================
function openPlayer(channel) {
  STATE.currentChannel = channel;
  addToRecent(channel);

  // Header
  DOM.playerTitle.textContent = channel.name || 'Unknown Channel';
  DOM.playerSub.textContent = [channel.category, channel.country].filter(Boolean).join(' · ');

  if (channel.logo) {
    DOM.playerLogo.src = channel.logo;
    DOM.playerLogo.style.display = '';
    DOM.playerLogo.onerror = () => { DOM.playerLogo.style.display = 'none'; };
  } else {
    DOM.playerLogo.style.display = 'none';
  }

  syncPlayerFavBtn();

  // Reset UI
  DOM.streamError.hidden = true;
  DOM.playerSpinner.classList.remove('hidden');
  DOM.playPauseIcon.textContent = '⏸';

  // Show modal
  DOM.playerModal.hidden = false;
  document.body.style.overflow = 'hidden';
  DOM.playerClose.focus();

  loadStream(channel.url);
}

function loadStream(url) {
  destroyHls();
  const video = DOM.videoPlayer;
  video.src = '';

  // Check if it's an HLS stream
  const isHls = /\.m3u8/i.test(url) || url.includes('m3u8');

  if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
    // Use HLS.js
    STATE.hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
    });
    STATE.hlsInstance.loadSource(url);
    STATE.hlsInstance.attachMedia(video);
    STATE.hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    STATE.hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) handleStreamError();
    });

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari)
    video.src = url;
    video.play().catch(() => {});

  } else {
    // Try direct src for non-HLS (MP4, etc.)
    video.src = url;
    video.play().catch(() => handleStreamError());
  }

  // Video events
  video.onwaiting  = () => DOM.playerSpinner.classList.remove('hidden');
  video.onplaying  = () => DOM.playerSpinner.classList.add('hidden');
  video.onpause    = () => { DOM.playPauseIcon.textContent = '▶'; };
  video.onplay     = () => { DOM.playPauseIcon.textContent = '⏸'; };
  video.onerror    = () => handleStreamError();
}

function handleStreamError() {
  DOM.playerSpinner.classList.add('hidden');
  DOM.streamError.hidden = false;
}

function destroyHls() {
  if (STATE.hlsInstance) {
    STATE.hlsInstance.destroy();
    STATE.hlsInstance = null;
  }
}

function closePlayer() {
  destroyHls();
  DOM.videoPlayer.pause();
  DOM.videoPlayer.src = '';
  DOM.playerModal.hidden = true;
  document.body.style.overflow = '';
  STATE.currentChannel = null;

  // If on recent view, refresh the list
  if (STATE.view === 'recent') applyFilters();
}

// =====================================================
// PLAYER CONTROLS
// =====================================================
function setupPlayerControls() {
  const video = DOM.videoPlayer;

  DOM.playPauseBtn.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });

  DOM.muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    DOM.muteBtn.textContent = video.muted ? '🔇' : '🔊';
  });

  DOM.volumeSlider.addEventListener('input', () => {
    video.volume = DOM.volumeSlider.value;
    video.muted = video.volume === 0;
    DOM.muteBtn.textContent = video.muted ? '🔇' : '🔊';
  });

  DOM.fullscreenBtn.addEventListener('click', toggleFullscreen);

  DOM.playerFavBtn.addEventListener('click', () => {
    if (STATE.currentChannel) toggleFavorite(STATE.currentChannel, null);
  });

  DOM.playerClose.addEventListener('click', closePlayer);
  DOM.playerBackdrop.addEventListener('click', closePlayer);
}

function toggleFullscreen() {
  const container = DOM.videoPlayer;
  if (!document.fullscreenElement) {
    (container.requestFullscreen || container.webkitRequestFullscreen || container.mozRequestFullScreen)
      .call(container).catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// =====================================================
// INTERSECTION OBSERVER (infinite scroll)
// =====================================================
function setupIntersectionObserver() {
  STATE.intersectionObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) renderNextBatch();
    },
    { rootMargin: '200px' }
  );
  STATE.intersectionObserver.observe(DOM.sentinel);
}

// =====================================================
// UI STATE HELPERS
// =====================================================
function showLoading(on) {
  DOM.loadingOverlay.classList.toggle('hidden', !on);
}
function showError(on) {
  DOM.errorState.hidden = !on;
}
function showEmpty(on) {
  DOM.emptyState.hidden = !on;
}

// =====================================================
// TOAST
// =====================================================
let toastTimer;
function showToast(msg) {
  DOM.toast.textContent = msg;
  DOM.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => DOM.toast.classList.remove('visible'), CONFIG.toastDuration);
}

// =====================================================
// UTILITY
// =====================================================
function escHtml(str) {
  if (!str) return '';
  return str
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
  // Theme
  DOM.darkModeToggle.addEventListener('click', toggleTheme);

  // Search toggle
  DOM.searchToggleBtn.addEventListener('click', () => {
    const isOpen = DOM.searchBar.classList.toggle('open');
    DOM.searchBar.setAttribute('aria-hidden', String(!isOpen));
    if (isOpen) DOM.searchInput.focus();
    else {
      DOM.searchInput.value = '';
      STATE.search = '';
      applyFilters();
    }
  });

  // Search input (debounced)
  DOM.searchInput.addEventListener('input', debounce((e) => {
    STATE.search = e.target.value;
    applyFilters();
  }, 250));

  // Search clear
  DOM.searchClear.addEventListener('click', () => {
    DOM.searchInput.value = '';
    STATE.search = '';
    applyFilters();
    DOM.searchInput.focus();
  });

  // Category filter
  DOM.categoryFilter.addEventListener('change', (e) => {
    STATE.category = e.target.value;
    applyFilters();
  });

  // Country filter
  DOM.countryFilter.addEventListener('change', (e) => {
    STATE.country = e.target.value;
    applyFilters();
  });

  // Nav buttons (Home / Favorites / Recent)
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

  // Retry
  DOM.retryBtn.addEventListener('click', () => {
    showError(false);
    fetchPlaylist();
  });

  // Clear filters
  DOM.clearFiltersBtn.addEventListener('click', () => {
    DOM.searchInput.value = '';
    DOM.categoryFilter.value = '';
    DOM.countryFilter.value = '';
    STATE.search = '';
    STATE.category = '';
    STATE.country = '';
    applyFilters();
  });

  // Keyboard: Escape closes player
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.playerModal.hidden) closePlayer();
  });

  setupPlayerControls();
}

// =====================================================
// PWA — Service Worker Registration
// =====================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('[SW] Registered'))
      .catch(() => {}); // non-critical
  });
}

// =====================================================
// BOOT
// =====================================================
document.addEventListener('DOMContentLoaded', init);
