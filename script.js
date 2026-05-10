let ap = null;
let allSongs = [];
let filteredSongs = [];
let rawSongCovers = {};  // 记录每首歌的原始封面（url -> cover），用于区分"默认封面"和"自带封面"
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
const GITHUB_TOKEN_KEY = 'githubToken';
const GITHUB_REPO_KEY = 'githubRepo';

// WebDAV 读写工具（用于 GitHub Pages 环境下跨设备同步配置）
function getWebdavAuth() {
    try {
        const wc = JSON.parse(localStorage.getItem(WEBDAV_KEY) || 'null');
        if (wc && wc.url && wc.user && wc.pass) {
            return {
                url: wc.url.replace(/\/+$/, '') + '/',
                auth: btoa(wc.user + ':' + wc.pass)
            };
        }
    } catch (_) {}
    return null;
}

async function webdavGet(path) {
    const wd = getWebdavAuth();
    if (!wd) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(wd.url + path, {
            headers: { 'Authorization': 'Basic ' + wd.auth },
            signal: controller.signal
        });
        if (!res.ok) return null;
        return res.json();
    } finally { clearTimeout(timer); }
}

async function webdavPut(path, data) {
    const wd = getWebdavAuth();
    if (!wd) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(wd.url + path, {
            method: 'PUT',
            headers: {
                'Authorization': 'Basic ' + wd.auth,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data),
            signal: controller.signal
        });
        return res.ok;
    } finally { clearTimeout(timer); }
}

// GitHub API：保存配置到仓库（GitHub Pages 环境下跨设备共享）
const GITHUB_CONFIG_PATH = '_live-config.json';

async function githubSaveConfig(config) {
    const token = localStorage.getItem(GITHUB_TOKEN_KEY);
    const repo = localStorage.getItem(GITHUB_REPO_KEY);
    if (!token || !repo) { console.warn('GitHub 同步: 缺少 Token 或仓库名'); return false; }

    const apiUrl = `https://api.github.com/repos/${repo}/contents/${GITHUB_CONFIG_PATH}`;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(config, null, 2))));

    try {
        // 先获取文件的 SHA（如果存在）
        let sha = null;
        const getRes = await fetch(apiUrl, {
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (getRes.ok) {
            const existing = await getRes.json();
            sha = existing.sha;
        } else if (getRes.status !== 404) {
            const err = await getRes.json().catch(() => ({}));
            console.warn('GitHub 获取文件失败:', getRes.status, err.message || '');
            return false;
        }

        // 提交新内容
        const body = { message: '更新网站配置 [自动]', content, sha };
        const putRes = await fetch(apiUrl, {
            method: 'PUT',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        if (!putRes.ok) {
            const err = await putRes.json().catch(() => ({}));
            console.warn('GitHub 提交失败:', putRes.status, err.message || '');
        }
        return putRes.ok;
    } catch (e) { console.warn('GitHub 同步异常:', e); return false; }
}

function applyDefaultCoverToSongs() {
    try {
        const st = JSON.parse(localStorage.getItem(STYLE_CONFIG_KEY) || '{}');
        applyDefaultCover(st.defaultCover);
    } catch (_) {}
}

function applyDefaultCover(coverUrl) {
    if (!coverUrl || allSongs.length === 0) return;
    allSongs.forEach(s => {
        const key = s.url || s.name;
        // 只有原始封面为空的歌曲才用默认封面
        if (!rawSongCovers[key]) s.cover = coverUrl;
    });
    filteredSongs = [...allSongs];
    updatePlaylistUI(filteredSongs);
    if (ap) {
        const currentIdx = ap.list.index >= 0 ? ap.list.index : 0;
        setupPlayer(filteredSongs);
        if (currentIdx < ap.list.audios.length) {
            ap.list.switch(currentIdx);
        }
    }
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

async function fetchServerConfig() {
    try {
        // 3 秒超时，避免 GitHub Pages 上无服务端时卡住
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const res = await fetch('/api/config?_=' + Date.now(), { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return;
        const data = await res.json();
        if (data.site) {
            applySiteConfig(data.site);
            localStorage.setItem(SITE_CONFIG_KEY, JSON.stringify(data.site));
        }
        if (data.style) {
            applyStyleConfig(data.style);
            localStorage.setItem(STYLE_CONFIG_KEY, JSON.stringify(data.style));
            applyDefaultCover(data.style.defaultCover);
        }
    } catch (_) { /* 服务端不可用，用 localStorage */ }
}

// 从 GitHub raw 拉取 _live-config.json（GitHub Pages 全设备共享）
async function fetchGitHubConfig() {
    const repo = localStorage.getItem(GITHUB_REPO_KEY) || (window.__SITE_CONFIG__ && window.__SITE_CONFIG__.repo);
    if (!repo) return;
    const url = `https://raw.githubusercontent.com/${repo}/main/${GITHUB_CONFIG_PATH}`;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url + '?_=' + Date.now(), { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return;
        const data = await res.json();
        if (data.style) {
            applyStyleConfig(data.style);
            localStorage.setItem(STYLE_CONFIG_KEY, JSON.stringify(data.style));
        }
        if (data.site) {
            applySiteConfig(data.site);
            localStorage.setItem(SITE_CONFIG_KEY, JSON.stringify(data.site));
        }
    } catch (_) { /* 忽略 */ }
}

async function init() {
    setupTheme();
    setupAdmin();
    // 从 site-config.js 读取静态配置（同步，随代码部署的所有设备共享）
    const siteCfg = window.__SITE_CONFIG__;
    if (siteCfg) {
        if (siteCfg.style) {
            applyStyleConfig(siteCfg.style);
            localStorage.setItem(STYLE_CONFIG_KEY, JSON.stringify(siteCfg.style));
        }
        if (siteCfg.site) {
            applySiteConfig(siteCfg.site);
            localStorage.setItem(SITE_CONFIG_KEY, JSON.stringify(siteCfg.site));
        }
    }
    // 从 WebDAV 拉取最新配置（GitHub Pages 环境下全设备实时共享）
    try {
        const wdCfg = await webdavGet('_config.json');
        if (wdCfg) {
            if (wdCfg.style) {
                applyStyleConfig(wdCfg.style);
                localStorage.setItem(STYLE_CONFIG_KEY, JSON.stringify(wdCfg.style));
            }
            if (wdCfg.site) {
                applySiteConfig(wdCfg.site);
                localStorage.setItem(SITE_CONFIG_KEY, JSON.stringify(wdCfg.site));
            }
        }
    } catch (_) {}
    // 从 GitHub raw 拉取 _live-config.json（GitHub Pages 全设备共享）
    await fetchGitHubConfig();
    // 从服务端拉取（本地运行 server.js 时生效）
    await fetchServerConfig();
    // 加载歌曲
    await fetchMusicData();
    saveRawCovers();
    applyDefaultCoverToSongs();
    setupPlayer(filteredSongs);
    setupPlayMode();
    setupSearch();
    setupHistory();
    setupKeyboard();
    updatePlaylistUI(filteredSongs);
    updateSongCount();
    document.getElementById('refreshBtn').addEventListener('click', refreshSongs);

    setInterval(async () => {
        try {
            const res = await fetch('/api/songs?_=' + Date.now());
            if (!res.ok) return;
            const newSongs = await res.json();
            if (JSON.stringify(newSongs) !== JSON.stringify(allSongs)) {
                allSongs = newSongs;
                filteredSongs = [...allSongs];
                saveRawCovers();
                applyDefaultCoverToSongs();
                setupPlayer(filteredSongs);
                updatePlaylistUI(filteredSongs);
                updateSongCount();
            }
        } catch (_) {}
    }, 5 * 60 * 1000);
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
        const ghToken = localStorage.getItem(GITHUB_TOKEN_KEY);
        if (ghToken) document.getElementById('githubToken').value = ghToken;
        const ghRepo = localStorage.getItem(GITHUB_REPO_KEY);
        if (ghRepo) document.getElementById('githubRepo').value = ghRepo;
        settingsStatus.textContent = '';
    }

    async function saveSettings() {
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
        // 保存 GitHub Token / 仓库名
        const ghToken = document.getElementById('githubToken').value.trim();
        const ghRepo = document.getElementById('githubRepo').value.trim();
        if (ghToken) localStorage.setItem(GITHUB_TOKEN_KEY, ghToken);
        if (ghRepo) localStorage.setItem(GITHUB_REPO_KEY, ghRepo);

        // Re-apply default cover
        applyDefaultCoverToSongs();
        updatePlaylistUI(filteredSongs);

        // 保存到服务端（本地运行 server.js 时生效）
        fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: sc, style: st, repo: ghRepo })
        }).catch(() => {});
        // 保存到 GitHub 仓库（GitHub Pages 环境下全设备共享）
        const ghOk = await githubSaveConfig({ site: sc, style: st });
        if (ghOk) {
            settingsStatus.textContent = '设置已保存，已同步到 GitHub';
        } else {
            settingsStatus.textContent = '设置已保存（GitHub 同步失败，Token 或仓库名可能不正确）';
        }
        settingsStatus.className = 'form-status';
        showToast('设置已保存');
    }

    // Apply saved config on load
    const savedSite = localStorage.getItem(SITE_CONFIG_KEY);
    if (savedSite) { try { applySiteConfig(JSON.parse(savedSite)); } catch (_) {} }
    const savedStyle = localStorage.getItem(STYLE_CONFIG_KEY);
    if (savedStyle) { try { applyStyleConfig(JSON.parse(savedStyle)); } catch (_) {} }

    document.getElementById('testWebdavBtn').addEventListener('click', testWebdavConnection);

    async function testWebdavConnection() {
        const webdavUrl = document.getElementById('webdavUrl').value.trim();
        const webdavUser = document.getElementById('webdavUser').value.trim();
        const webdavPass = document.getElementById('webdavPass').value;
        if (!webdavUrl || !webdavUser || !webdavPass) {
            settingsStatus.textContent = '请先填写完整的 WebDAV 信息';
            settingsStatus.className = 'form-status error';
            return;
        }
        settingsStatus.textContent = '正在测试连接...';
        settingsStatus.className = 'form-status';
        try {
            const res = await fetch('/api/test-webdav', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: webdavUrl, user: webdavUser, pass: webdavPass })
            });
            const data = await res.json();
            if (data.success) {
                settingsStatus.textContent = '连接成功，正在扫描歌曲...';
                settingsStatus.className = 'form-status';
                saveSettings();
                try {
                    await fetch('/api/regenerate', { method: 'POST' });
                } catch (_) {}
                const refreshRes = await fetch('/api/songs?_=' + Date.now());
                if (refreshRes.ok) {
                    const songs = await refreshRes.json();
                    settingsStatus.textContent = '扫描完成，共 ' + songs.length + ' 首歌曲';
                    settingsStatus.className = 'form-status success';
                    allSongs = songs;
                    filteredSongs = [...allSongs];
                    saveRawCovers();
                    applyDefaultCoverToSongs();
                    setupPlayer(filteredSongs);
                    updatePlaylistUI(filteredSongs);
                    updateSongCount();
                }
            } else {
                settingsStatus.textContent = '连接失败：' + (data.error || '未知错误');
                settingsStatus.className = 'form-status error';
            }
        } catch (e) {
            settingsStatus.textContent = '连接失败：服务端 API 不可用，请确保已启动 server.js';
            settingsStatus.className = 'form-status error';
        }
    }

    document.getElementById('exportEncBtn').addEventListener('click', cryptoExport);
    document.getElementById('importConfigBtn').addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            cryptoImport(e.target.files[0]);
            e.target.value = '';
        }
    });

    async function cryptoExport() {
        try {
            const val = id => (document.getElementById(id) || {}).value || '';
            const fullConfig = {
                site: {
                    favicon: val('siteFavicon'),
                    title: val('siteTitle'),
                    subtitle: val('siteSubtitle'),
                    footer: val('siteFooter')
                },
                webdav: {
                    url: val('webdavUrl'),
                    user: val('webdavUser'),
                    pass: val('webdavPass')
                },
                style: {
                    defaultCover: val('defaultCover'),
                    accentColor: val('accentColor')
                }
            };
            const blob = new Blob([JSON.stringify(fullConfig, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'music-config.json';
            a.click();
            URL.revokeObjectURL(a.href);
            if (settingsStatus) {
                settingsStatus.textContent = '配置文件已下载 (music-config.json)';
                settingsStatus.className = 'form-status';
            }
        } catch (e) {
            if (settingsStatus) {
                settingsStatus.textContent = '导出失败: ' + e.message;
                settingsStatus.className = 'form-status error';
            }
        }
    }

    async function cryptoImport(file) {
        try {
            const text = await file.text();
            const fullConfig = JSON.parse(text);
            if (fullConfig.site) {
                document.getElementById('siteFavicon').value = fullConfig.site.favicon || '';
                document.getElementById('siteTitle').value = fullConfig.site.title || '';
                document.getElementById('siteSubtitle').value = fullConfig.site.subtitle || '';
                document.getElementById('siteFooter').value = fullConfig.site.footer || '';
            }
            if (fullConfig.webdav) {
                document.getElementById('webdavUrl').value = fullConfig.webdav.url || '';
                document.getElementById('webdavUser').value = fullConfig.webdav.user || '';
                document.getElementById('webdavPass').value = fullConfig.webdav.pass || '';
            }
            if (fullConfig.style) {
                document.getElementById('defaultCover').value = fullConfig.style.defaultCover || '';
                if (fullConfig.style.accentColor) {
                    document.getElementById('accentColor').value = fullConfig.style.accentColor;
                    document.getElementById('accentColorText').value = fullConfig.style.accentColor;
                }
            }
            settingsStatus.textContent = '配置已导入，请点击保存设置';
            settingsStatus.className = 'form-status';
        } catch (e) {
            settingsStatus.textContent = '导入失败: ' + e.message;
            settingsStatus.className = 'form-status error';
        }
    }
}

function saveRawCovers() {
    rawSongCovers = {};
    allSongs.forEach(s => { rawSongCovers[s.url || s.name] = s.cover || ''; });
}

async function fetchMusicData() {
    try {
        const res = await fetch('/api/songs?_=' + Date.now());
        if (res.ok) { allSongs = await res.json(); filteredSongs = [...allSongs]; saveRawCovers(); return; }
    } catch (_) {}
    try {
        const res = await fetch('music.json?_=' + Date.now());
        if (!res.ok) throw new Error('Failed to load music.json');
        allSongs = await res.json();
        filteredSongs = [...allSongs];
        saveRawCovers();
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
        const res = await fetch('/api/songs?_=' + Date.now());
        if (!res.ok) throw new Error('load failed');
        allSongs = await res.json();
        filteredSongs = [...allSongs];
        saveRawCovers();
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
