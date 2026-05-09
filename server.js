const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'webdav-config.json');

let webdavConfig = null;
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (saved.url && saved.user && saved.pass) {
            saved.auth = 'Basic ' + Buffer.from(saved.user + ':' + saved.pass).toString('base64');
            saved.origin = new URL(saved.url).origin;
            webdavConfig = saved;
            console.log('Loaded WebDAV config from file');
        }
    } catch (e) { /* ignore */ }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.lrc': 'text/plain; charset=utf-8'
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function webdavClient(url) {
    return url.startsWith('https') ? require('https') : require('http');
}

function authHeader(user, pass) {
    return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

function webdavRequest(method, targetUrl, auth) {
    return new Promise((resolve, reject) => {
        const client = webdavClient(targetUrl);
        const opts = { method, headers: { 'Authorization': auth }, rejectUnauthorized: false };
        if (method === 'PROPFIND') opts.headers['Depth'] = '1';
        const req = client.request(targetUrl, opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        req.end();
    });
}

function parseWebdavFiles(xml) {
    const audioExts = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'];
    const files = [];
    const re = /<[^>]*:?href[^>]*>(.*?)<\/[^>]*:?href[^>]*>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
        let href = m[1].trim().replace(/&amp;/g, '&');
        const decoded = decodeURIComponent(href);
        const ext = path.extname(decoded).toLowerCase();
        if (audioExts.includes(ext)) {
            const baseName = path.basename(decoded).replace(/\.\w+$/, '');
            const dashIdx = baseName.lastIndexOf('-');
            let name = baseName, artist = '未知';
            if (dashIdx > 0) {
                name = baseName.slice(0, dashIdx).trim();
                artist = baseName.slice(dashIdx + 1).trim();
            }
            files.push({ name, artist, url: '/api/proxy/' + encodeURIComponent(decoded), cover: '' });
        }
    }
    return files;
}

async function getWebdavSongs() {
    if (!webdavConfig) return null;
    const result = await webdavRequest('PROPFIND', webdavConfig.url, webdavConfig.auth);
    if (result.status >= 400) return null;
    return parseWebdavFiles(result.data);
}

const server = http.createServer(async (req, res) => {
    const url = req.url;
    const method = req.method;

    function json(data, status) {
        res.writeHead(status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    // POST /api/test-webdav
    if (method === 'POST' && url === '/api/test-webdav') {
        try {
            const { url: wdUrl, user, pass } = JSON.parse(await readBody(req));
            if (!wdUrl || !user || pass === undefined) return json({ success: false, error: '缺少参数' });
            const auth = authHeader(user, pass);
            const result = await webdavRequest('OPTIONS', wdUrl, auth);
            if (result.status === 401) return json({ success: false, error: '用户名或密码错误' });
            if (result.status >= 500) return json({ success: false, error: 'HTTP ' + result.status });
            const origin = new URL(wdUrl).origin;
            webdavConfig = { url: wdUrl.replace(/\/+$/, '') + '/', user, pass, auth, origin };
            fs.writeFileSync(CONFIG_FILE, JSON.stringify({ url: webdavConfig.url, user, pass }), 'utf8');
            json({ success: true });
        } catch (e) { json({ success: false, error: e.message }); }
        return;
    }

    // GET /api/songs — return songs with proxy URLs (WebDAV) or fallback to music.json
    if (method === 'GET' && url.startsWith('/api/songs')) {
        try {
            if (webdavConfig) {
                const songs = await getWebdavSongs();
                if (songs) return json(songs);
            }
            const data = fs.readFileSync(path.join(ROOT, 'music.json'), 'utf8');
            json(JSON.parse(data));
        } catch (e) { json([]); }
        return;
    }

    // POST /api/regenerate — refresh song list (does NOT overwrite music.json in WebDAV mode)
    if (method === 'POST' && url === '/api/regenerate') {
        try {
            if (webdavConfig) {
                const songs = await getWebdavSongs();
                json({ ok: true, total: songs ? songs.length : 0 });
            } else {
                execSync('node scripts/generate-music-json.js', { cwd: ROOT, stdio: 'pipe' });
                json({ ok: true });
            }
        } catch (e) { res.writeHead(500); json({ ok: false, error: e.message }); }
        return;
    }

    // POST /api/regenerate-pages — generate music.json with local file URLs from WebDAV listing
    if (method === 'POST' && url === '/api/regenerate-pages') {
        try {
            if (!webdavConfig) return json({ ok: false, error: '请先测试 WebDAV 连接' });
            const songs = await getWebdavSongs();
            if (!songs) return json({ ok: false, error: 'PROPFIND 失败' });
            const localSongs = songs.map(s => ({
                name: s.name,
                artist: s.artist,
                url: 'music/' + decodeURIComponent(s.url.replace('/api/proxy/', '')).split('/').pop(),
                cover: s.cover
            }));
            fs.writeFileSync(path.join(ROOT, 'music.json'), JSON.stringify(localSongs, null, 2), 'utf8');
            json({ ok: true, total: localSongs.length });
        } catch (e) { res.writeHead(500); json({ ok: false, error: e.message }); }
        return;
    }

    // GET /api/debug
    if (method === 'GET' && url === '/api/debug') {
        json({
            configured: !!webdavConfig,
            origin: webdavConfig ? webdavConfig.origin : null,
            url: webdavConfig ? webdavConfig.url.replace(/\/\/[^@]+@/, '//***:***@') : null
        });
        return;
    }

    // GET /api/proxy/* — proxy audio from WebDAV
    if (method === 'GET' && url.startsWith('/api/proxy/')) {
        const startTime = Date.now();
        try {
            if (!webdavConfig) { res.writeHead(403); res.end('WebDAV not configured'); return; }
            const remotePath = decodeURIComponent(url.slice('/api/proxy/'.length));
            let targetUrl = remotePath.startsWith('http') ? remotePath : webdavConfig.origin + remotePath;
            const baseHeaders = { 'Authorization': webdavConfig.auth };
            if (req.headers.range) baseHeaders['Range'] = req.headers.range;

            function doFetch(fetchUrl, redirectCount) {
                if (redirectCount > 5) { res.writeHead(502); res.end('Too many redirects'); return; }
                const client = webdavClient(fetchUrl);
                const fetchReq = client.request(fetchUrl, {
                    method: 'GET', headers: baseHeaders, rejectUnauthorized: false
                }, (fetchRes) => {
                    if (fetchRes.statusCode >= 300 && fetchRes.statusCode < 400 && fetchRes.headers.location) {
                        const nextUrl = fetchRes.headers.location.startsWith('http') ? fetchRes.headers.location : new URL(fetchRes.headers.location, fetchUrl).href;
                        fetchRes.resume();
                        return doFetch(nextUrl, redirectCount + 1);
                    }
                    if (fetchRes.statusCode >= 400) {
                        let body = '';
                        fetchRes.on('data', c => body += c);
                        fetchRes.on('end', () => {
                            console.error('[PROXY] error', fetchRes.statusCode, fetchUrl, body.slice(0, 200));
                            res.writeHead(502); res.end('Proxy upstream error: ' + fetchRes.statusCode);
                        });
                        return;
                    }
                    const ext = path.extname(fetchUrl).toLowerCase();
                    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
                    if (fetchRes.headers['content-length']) h['Content-Length'] = fetchRes.headers['content-length'];
                    if (fetchRes.headers['content-range']) h['Content-Range'] = fetchRes.headers['content-range'];
                    if (req.headers.range) h['Accept-Ranges'] = 'bytes';
                    res.writeHead(fetchRes.statusCode, h);
                    fetchRes.pipe(res);
                });
                fetchReq.on('error', (e) => { res.writeHead(502); res.end('Proxy error: ' + e.message); });
                fetchReq.end();
            }
            doFetch(targetUrl, 0);
        } catch (e) { res.writeHead(500); res.end('Proxy error: ' + e.message); }
        return;
    }

    // Static files
    let filePath = path.join(ROOT, decodeURIComponent(url.split('?')[0]));
    if (filePath.endsWith(path.sep) || filePath.endsWith('/')) filePath = path.join(filePath, 'index.html');
    if (!path.extname(filePath)) filePath += '.html';
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache', 'Expires': '0',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Endpoints: /api/test-webdav, /api/songs, /api/regenerate, /api/proxy/*, /api/debug');
});
