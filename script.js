let ap = null;
let allSongs = [];
let filteredSongs = [];
let playHistory = JSON.parse(localStorage.getItem('musicPlayHistory') || '[]');
let currentPlayIndex = -1;
let isAdmin = false;
let playMode = localStorage.getItem('playMode') || 'sequential';

const CONFIG = {
    storageKey: 'musicPlayHistory',
    maxHistory: 100
};

const ADMIN_KEY = 'adminPassword';
const ADMIN_DEFAULT = 'admin123';
const WEBDAV_KEY = 'webdavConfig';
const ADMIN_SESSION_KEY = 'adminLoggedIn';
const SITE_CONFIG_KEY = 'siteConfig';
const STYLE_CONFIG_KEY = 'styleConfig';

function applyDefaultCoverToSongs() {
    try {
        const st = JSON.parse(localStorage.getItem(STYLE_CONFIG_KEY) || '{}');
        if (st.defaultCover) {
            allSongs.forEach(s => { if (!s.cover) s.cover = st.defaultCover; });
        }
    } catch (_) {}
}

function init() {
    setupTheme();
    setupAdmin();
    fetchMusicData().then(() => {
        applyDefaultCoverToSongs();
        setupPlayer(filteredSongs);
        setupPlayMode();
        setupSearch();
        setupHistory();
        setupKeyboard();
        updatePlaylistUI(filteredSongs);
        updateSongCount();
    });
    document.getElementById('refreshBtn').addEventListener('click', refreshSongs);
}

function setupTheme() {
    const saved = localStorage.getItem('theme') || 'light';
    applyTheme(saved);

    document.getElementById('themeToggle').addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        localStorage.setItem('theme', next);
        showToast(next === 'dark' ? '已切换夜间模式' : '已切换白天模式');
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const sun = document.querySelector('.theme-icon-sun');
    const moon = document.querySelector('.theme-icon-moon');
    const metaTheme = document.getElementById('themeColor');
    if (theme === 'dark') {
        sun.style.display = '';
        moon.style.display = 'none';
        if (metaTheme) metaTheme.content = '#0f0c29';
    } else {
        sun.style.display = 'none';
        moon.style.display = '';
        if (metaTheme) metaTheme.content = '#ffffff';
    }
}

function setupAdmin() {
    const adminBtn = document.getElementById('adminBtn');
    const loginModal = document.getElementById('loginModal');
    const loginClose = document.getElementById('loginModalClose');
    const settingsModal = document.getElementById('settingsModal');
    const settingsClose = document.getElementById('settingsModalClose');
    const loginError = document.getElementById('loginError');
    const settingsStatus = document.getElementById('settingsStatus');
    const rememberMe = document.getElementById('rememberMe');

    const savedHash = localStorage.getItem(ADMIN_KEY);
    if (!savedHash) {
        const hash = btoa(ADMIN_DEFAULT);
        localStorage.setItem(ADMIN_KEY, hash);
    }

    if (localStorage.getItem(ADMIN_SESSION_KEY) === 'true') {
        isAdmin = true;
        adminBtn.classList.add('active');
    }

    // Tab switching
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const pane = document.getElementById('pane-' + tab.dataset.tab);
            if (pane) pane.classList.add('active');
        });
    });

    // Color picker sync
    const accentColor = document.getElementById('accentColor');
    const accentColorText = document.getElementById('accentColorText');
    if (accentColor && accentColorText) {
        accentColor.addEventListener('input', () => { accentColorText.value = accentColor.value; });
        accentColorText.addEventListener('input', () => {
            if (/^#[0-9a-f]{6}$/i.test(accentColorText.value)) accentColor.value = accentColorText.value;
        });
    }

    adminBtn.addEventListener('click', () => {
        if (isAdmin) {
            loadSettings();
            settingsModal.classList.add('active');
        } else {
            document.getElementById('loginPassword').value = '';
            loginError.textContent = '';
            loginModal.classList.add('active');
            setTimeout(() => document.getElementById('loginPassword').focus(), 100);
        }
    });

    loginClose.addEventListener('click', () => loginModal.classList.remove('active'));
    loginModal.addEventListener('click', (e) => {
        if (e.target === loginModal) loginModal.classList.remove('active');
    });
    settingsClose.addEventListener('click', () => settingsModal.classList.remove('active'));
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.classList.remove('active');
    });

    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doLogin();
    });

    document.getElementById('loginBtn').addEventListener('click', doLogin);

    function doLogin() {
        const input = document.getElementById('loginPassword').value;
        const saved = localStorage.getItem(ADMIN_KEY) || btoa(ADMIN_DEFAULT);
        if (btoa(input) === saved) {
            isAdmin = true;
            loginModal.classList.remove('active');
            loginError.textContent = '';
            adminBtn.classList.add('active');
            if (rememberMe.checked) {
                localStorage.setItem(ADMIN_SESSION_KEY, 'true');
            } else {
                localStorage.removeItem(ADMIN_SESSION_KEY);
            }
            showToast('登录成功');
            loadSettings();
        } else {
            loginError.textContent = '密码错误';
        }
    }

    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
    document.getElementById('lockBtn').addEventListener('click', () => {
        isAdmin = false;
        adminBtn.classList.remove('active');
        localStorage.removeItem(ADMIN_SESSION_KEY);
        settingsModal.classList.remove('active');
        showToast('已锁定');
    });

    function loadSettings() {
        const webdav = localStorage.getItem(WEBDAV_KEY);
        if (webdav) {
            try {
                const c = JSON.parse(webdav);
                document.getElementById('webdavUrl').value = c.url || '';
                document.getElementById('webdavUser').value = c.user || '';
                document.getElementById('webdavPass').value = c.pass || '';
            } catch (_) {}
        }
        const site = localStorage.getItem(SITE_CONFIG_KEY);
        if (site) {
            try {
                const c = JSON.parse(site);
                document.getElementById('siteFavicon').value = c.favicon || '';
                document.getElementById('siteTitle').value = c.title || '';
                document.getElementById('siteSubtitle').value = c.subtitle || '';
                document.getElementById('siteFooter').value = c.footer || '';
            } catch (_) {}
        }
        const style = localStorage.getItem(STYLE_CONFIG_KEY);
        if (style) {
            try {
                const c = JSON.parse(style);
                document.getElementById('defaultCover').value = c.defaultCover || '';
                if (c.accentColor) {
                    document.getElementById('accentColor').value = c.accentColor;
                    document.getElementById('accentColorText').value = c.accentColor;
                }
            } catch (_) {}
        }
        document.getElementById('adminNewPassword').value = '';
        settingsStatus.textContent = '';
    }

    function saveSettings() {
        // Save music source
        const wc = {
            url: document.getElementById('webdavUrl').value.trim(),
            user: document.getElementById('webdavUser').value.trim(),
            pass: document.getElementById('webdavPass').value
        };
        localStorage.setItem(WEBDAV_KEY, JSON.stringify(wc));

        // Save site config
        const sc = {
            favicon: document.getElementById('siteFavicon').value.trim(),
            title: document.getElementById('siteTitle').value.trim(),
            subtitle: document.getElementById('siteSubtitle').value.trim(),
            footer: document.getElementById('siteFooter').value.trim()
        };
        localStorage.setItem(SITE_CONFIG_KEY, JSON.stringify(sc));

        // Save style config
        const st = {
            defaultCover: document.getElementById('defaultCover').value.trim(),
            accentColor: document.getElementById('accentColor').value
        };
        localStorage.setItem(STYLE_CONFIG_KEY, JSON.stringify(st));

        // Apply immediately
        applySiteConfig(sc);
        applyStyleConfig(st);

        const newPass = document.getElementById('adminNewPassword').value;
        if (newPass) {
            localStorage.setItem(ADMIN_KEY, btoa(newPass));
            document.getElementById('adminNewPassword').value = '';
        }

        // Re-apply default cover
        applyDefaultCoverToSongs();
        updatePlaylistUI(filteredSongs);

        settingsStatus.textContent = '设置已保存';
        settingsStatus.className = 'form-status';
        showToast('设置已保存');
    }

    function applySiteConfig(cfg) {
        const titleEl = document.querySelector('.site-title');
        const subtitleEl = document.querySelector('.site-subtitle');
        const favicon = document.querySelector('link[rel="icon"]');
        const docTitle = document.querySelector('title');
        const footerEl = document.querySelector('.footer p');
        if (cfg.title && titleEl) titleEl.textContent = cfg.title;
        if (cfg.subtitle && subtitleEl) subtitleEl.textContent = cfg.subtitle;
        if (cfg.favicon && favicon) favicon.href = cfg.favicon;
        if (cfg.title && docTitle) docTitle.textContent = cfg.title;
        if (cfg.footer && footerEl) footerEl.textContent = cfg.footer;
    }

    function applyStyleConfig(cfg) {
        if (cfg.accentColor) {
            document.documentElement.style.setProperty('--accent', cfg.accentColor);
            if (ap) ap.theme = cfg.accentColor;
        }
    }

    // Apply saved config on load
    const savedSite = localStorage.getItem(SITE_CONFIG_KEY);
    if (savedSite) { try { applySiteConfig(JSON.parse(savedSite)); } catch (_) {} }
    const savedStyle = localStorage.getItem(STYLE_CONFIG_KEY);
    if (savedStyle) { try { applyStyleConfig(JSON.parse(savedStyle)); } catch (_) {} }

    document.getElementById('exportConfigBtn').addEventListener('click', () => {
        const cfg = {
            url: document.getElementById('webdavUrl').value.trim(),
            user: document.getElementById('webdavUser').value.trim(),
            pass: document.getElementById('webdavPass').value
        };
        if (!cfg.url || !cfg.user || !cfg.pass) {
            settingsStatus.textContent = '请先填写完整的 WebDAV 信息';
            settingsStatus.className = 'form-status error';
            return;
        }
        const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'webdav-config.json';
        a.click();
        URL.revokeObjectURL(a.href);
        settingsStatus.textContent = '配置文件已下载，请提交到仓库根目录';
        settingsStatus.className = 'form-status';
    });
}

async function fetchMusicData() {
    try {
        const res = await fetch('music.json?_=' + Date.now());
        if (!res.ok) throw new Error('Failed to load music.json');
        allSongs = await res.json();
        filteredSongs = [...allSongs];
    } catch (e) {
        console.warn('music.json not found or empty');
        allSongs = [];
        filteredSongs = [];
    }
}

function setupPlayer(songs) {
    const container = document.getElementById('player');
    container.innerHTML = '';

    if (!songs || songs.length === 0) {
        container.innerHTML = '<div class="player-empty">暂无歌曲可播放</div>';
        return;
    }

    const savedVolume = parseFloat(localStorage.getItem('playerVolume')) || 0.7;

    const audio = songs.map(song => ({
        name: song.name || '未知歌曲',
        artist: song.artist || '未知',
        url: song.url || '',
        cover: song.cover || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23333"/><text y=".9em" font-size="40" x="25" y="65">🎵</text></svg>',
        lrc: song.lrc || ''
    }));

    ap = new APlayer({
        container: document.getElementById('player'),
        audio: audio,
        mini: false,
        autoplay: false,
        theme: '#3b82f6',
        loop: 'all',
        order: 'list',
        preload: 'metadata',
        volume: savedVolume,
        mutex: true,
        listFolded: false,
        listMaxHeight: 200,
        lrcType: 3
    });

    ap.on('play', function () {
        const idx = ap.list.index;
        highlightSong(idx);
        addToHistory(idx);
    });

    ap.on('ended', function () {
        if (playMode === 'shuffle') {
            const randIdx = Math.floor(Math.random() * ap.list.audios.length);
            ap.list.switch(randIdx);
            ap.play();
        } else if (playMode === 'single') {
            ap.seek(0);
            ap.play();
        }
    });

    ap.on('volumechange', function () {
        localStorage.setItem('playerVolume', ap.volume);
    });
}

function highlightSong(index) {
    document.querySelectorAll('.playlist li').forEach((li, i) => {
        li.classList.toggle('active', i === index);
        if (i === index) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    updateBgGradient(index);
}

function updateBgGradient(index) {
    const bg = document.querySelector('.bg-gradient');
    if (index >= 0 && index < allSongs.length && allSongs[index].cover) {
        bg.style.background = `url(${allSongs[index].cover}) center/cover no-repeat`;
        bg.style.filter = 'blur(60px) saturate(1.5)';
    } else {
        bg.style.background = '';
        bg.style.filter = '';
    }
}

function updatePlaylistUI(songs) {
    const list = document.getElementById('playlist');
    const empty = document.getElementById('emptyState');
    list.innerHTML = '';

    if (!songs || songs.length === 0) {
        empty.style.display = 'flex';
        list.style.display = 'none';
        return;
    }

    empty.style.display = 'none';
    list.style.display = '';

    songs.forEach((song, i) => {
        const li = document.createElement('li');
        li.className = 'playlist-item';
        li.setAttribute('data-index', i);

        const coverUrl = song.cover || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23333"/><text y=".9em" font-size="40" x="25" y="65">🎵</text></svg>';

        li.innerHTML = `
            <div class="playlist-item-cover">
                <img src="${coverUrl}" alt="${song.name}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext y=%22.9em%22 font-size=%2240%22 x=%2225%22 y=%2265%22%3E🎵%3C/text%3E%3C/svg%3E'">
            </div>
            <div class="playlist-item-info">
                <span class="playlist-item-name">${song.name || '未知歌曲'}</span>
                <span class="playlist-item-artist">${song.artist || '未知'}</span>
            </div>
            <div class="playlist-item-indicator"></div>
        `;

        li.addEventListener('click', () => {
            const globalIdx = allSongs.indexOf(song);
            if (globalIdx !== -1 && ap) {
                ap.list.switch(globalIdx);
                ap.play();
            }
        });

        list.appendChild(li);
    });
}

function updateSongCount() {
    document.getElementById('songCount').textContent = filteredSongs.length + ' 首';
}

function setupSearch() {
    const input = document.getElementById('searchInput');
    let timer = null;

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const query = input.value.trim().toLowerCase();
            if (!query) {
                filteredSongs = [...allSongs];
            } else {
                filteredSongs = allSongs.filter(song =>
                    (song.name && song.name.toLowerCase().includes(query)) ||
                    (song.artist && song.artist.toLowerCase().includes(query))
                );
            }
            updatePlaylistUI(filteredSongs);
            updateSongCount();
        }, 300);
    });
}

function setupPlayMode() {
    const modeLabels = { sequential: '顺序播放', shuffle: '随机播放', single: '单曲循环' };
    const indicator = document.getElementById('modeIndicator');

    applyPlayMode(playMode);

    document.querySelectorAll('.play-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            applyPlayMode(mode);
            showToast('已切换' + modeLabels[mode]);
        });
    });

    function applyPlayMode(mode) {
        playMode = mode;
        localStorage.setItem('playMode', mode);

        document.querySelectorAll('.play-mode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });

        indicator.textContent = modeLabels[mode] || '顺序播放';

        if (mode === 'shuffle' && ap && ap.list.audios.length > 0) {
            const randIdx = Math.floor(Math.random() * ap.list.audios.length);
            ap.list.switch(randIdx);
        }
    }
}

function setupHistory() {
    const btn = document.getElementById('playHistoryBtn');
    const modal = document.getElementById('historyModal');
    const closeBtn = document.getElementById('historyModalClose');

    btn.addEventListener('click', () => {
        renderHistory();
        modal.classList.add('active');
    });

    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });

    document.getElementById('clearHistoryBtn').addEventListener('click', () => {
        playHistory = [];
        localStorage.removeItem(CONFIG.storageKey);
        renderHistory();
        showToast('播放历史已清空');
    });
}

function addToHistory(index) {
    if (index < 0 || index >= allSongs.length) return;
    const song = allSongs[index];
    playHistory = playHistory.filter(h => h.name !== song.name || h.artist !== song.artist);
    playHistory.unshift({ name: song.name, artist: song.artist, cover: song.cover, time: Date.now() });
    if (playHistory.length > CONFIG.maxHistory) playHistory.pop();
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(playHistory));
}

function renderHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = '';

    if (playHistory.length === 0) {
        list.innerHTML = '<li class="history-empty">暂无播放记录</li>';
        return;
    }

    playHistory.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'history-item';
        li.innerHTML = `
            <div class="history-item-cover">
                <img src="${item.cover || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext y=%22.9em%22 font-size=%2240%22 x=%2225%22 y=%2265%22%3E🎵%3C/text%3E%3C/svg%3E'}" alt="${item.name}" loading="lazy">
            </div>
            <div class="history-item-info">
                <span class="history-item-name">${item.name || '未知歌曲'}</span>
                <span class="history-item-artist">${item.artist || '未知'}</span>
            </div>
        `;
        li.addEventListener('click', () => {
            const idx = allSongs.findIndex(s => s.name === item.name && s.artist === item.artist);
            if (idx !== -1 && ap) {
                ap.list.switch(idx);
                ap.play();
                document.getElementById('historyModal').classList.remove('active');
            }
        });
        list.appendChild(li);
    });
}

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && e.target === document.body) {
            e.preventDefault();
            if (ap) {
                if (ap.audio.paused) ap.play();
                else ap.pause();
            }
        }
    });
}

function scrollToCurrent() {
    if (!ap || ap.list.index < 0) return;
    const items = document.querySelectorAll('.playlist-item');
    const idx = ap.list.index;
    if (items[idx]) {
        items[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightSong(idx);
    }
}

document.getElementById('nowPlayingBtn').addEventListener('click', scrollToCurrent);

async function refreshSongs() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('refreshing');
    try {
        await fetch('/api/regenerate', { method: 'POST' });
    } catch (_) {}
    try {
        const res = await fetch('music.json?_=' + Date.now());
        if (!res.ok) throw new Error('load failed');
        allSongs = await res.json();
        filteredSongs = [...allSongs];
        applyDefaultCoverToSongs();
        setupPlayer(filteredSongs);
        updatePlaylistUI(filteredSongs);
        updateSongCount();
        const input = document.getElementById('searchInput');
        if (input.value.trim()) {
            input.value = '';
            filteredSongs = [...allSongs];
            updatePlaylistUI(filteredSongs);
            updateSongCount();
        }
        showToast('歌单已刷新');
    } catch (e) {
        showToast('刷新失败: ' + e.message);
    }
    btn.classList.remove('refreshing');
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('active');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('active'), 2000);
}

document.addEventListener('DOMContentLoaded', init);
