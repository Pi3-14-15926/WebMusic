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

function authHeader(url, user, pass) {
    return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

function webdavRequest(method, targetUrl, auth, body) {
    return new Promise((resolve, reject) => {
        const client = webdavClient(targetUrl);
        const opts = { method, headers: { 'Authorization': auth }, rejectUnauthorized: false };
        if (method === 'PROPFIND') { opts.headers['Depth'] = '1'; opts.headers['Content-Type'] = 'application/xml'; }
        const req = client.request(targetUrl, opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
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

const server = http.createServer(async (req, res) => {
    const url = req.url;
    const method = req.method;

    // POST /api/test-webdav — test + save config in memory
    if (method === 'POST' && url === '/api/test-webdav') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        try {
            const { url: wdUrl, user, pass } = JSON.parse(await readBody(req));
            if (!wdUrl || !user || pass === undefined) throw new Error('缺少参数');
            const auth = authHeader(wdUrl, user, pass);
            const result = await webdavRequest('OPTIONS', wdUrl, auth, null);
            if (result.status === 401) {
                res.end(JSON.stringify({ success: false, error: '用户名或密码错误' }));
            } else if (result.status < 500) {
                const origin = new URL(wdUrl).origin;
                webdavConfig = { url: wdUrl.replace(/\/+$/, '') + '/', user, pass, auth, origin };
                fs.writeFileSync(CONFIG_FILE, JSON.stringify({ url: webdavConfig.url, user, pass }), 'utf8');
                res.end(JSON.stringify({ success: true }));
            } else {
                res.end(JSON.stringify({ success: false, error: 'HTTP ' + result.status }));
            }
        } catch (e) {
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // POST /api/sync-webdav — scan WebDAV, generate music.json with proxy URLs
    if (method === 'POST' && url === '/api/sync-webdav') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        try {
            if (!webdavConfig) throw new Error('请先测试 WebDAV 连接');
            const { url: wdUrl, auth } = webdavConfig;
            const result = await webdavRequest('PROPFIND', wdUrl, auth);
            if (result.status >= 400) throw new Error('PROPFIND 失败: HTTP ' + result.status);
            const songs = parseWebdavFiles(result.data);
            fs.writeFileSync(path.join(ROOT, 'music.json'), JSON.stringify(songs, null, 2), 'utf8');
            res.end(JSON.stringify({ success: true, total: songs.length }));
        } catch (e) {
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // GET /api/debug — show proxy config (for debugging)
    if (method === 'GET' && url === '/api/debug') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            configured: !!webdavConfig,
            origin: webdavConfig ? webdavConfig.origin : null,
            url: webdavConfig ? webdavConfig.url.replace(/\/\/[^@]+@/, '//***:***@') : null
        }));
        return;
    }

    // GET /api/proxy/* — proxy audio from WebDAV (with redirect following)
    if (method === 'GET' && url.startsWith('/api/proxy/')) {
        const startTime = Date.now();
        try {
            if (!webdavConfig) {
                res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('WebDAV not configured');
                return;
            }
            const remotePath = decodeURIComponent(url.slice('/api/proxy/'.length));
            let targetUrl = remotePath.startsWith('http') ? remotePath : webdavConfig.origin + remotePath;
            const baseHeaders = { 'Authorization': webdavConfig.auth };
            if (req.headers.range) baseHeaders['Range'] = req.headers.range;

            function doFetch(fetchUrl, redirectCount) {
                if (redirectCount > 5) {
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Too many redirects');
                    return;
                }
                const client = webdavClient(fetchUrl);
                const fetchReq = client.request(fetchUrl, {
                    method: 'GET',
                    headers: baseHeaders,
                    rejectUnauthorized: false
                }, (fetchRes) => {
                    if (fetchRes.statusCode >= 300 && fetchRes.statusCode < 400 && fetchRes.headers.location) {
                        const location = fetchRes.headers.location;
                        const nextUrl = location.startsWith('http') ? location : new URL(location, fetchUrl).href;
                        console.log('[PROXY] redirect', fetchRes.statusCode, '->', nextUrl);
                        fetchRes.resume();
                        doFetch(nextUrl, redirectCount + 1);
                        return;
                    }
                    if (fetchRes.statusCode >= 400) {
                        let body = '';
                        fetchRes.on('data', c => body += c);
                        fetchRes.on('end', () => {
                            console.error('[PROXY] error', fetchRes.statusCode, fetchUrl, body.slice(0, 200));
                            res.writeHead(502, { 'Content-Type': 'text/plain' });
                            res.end('Proxy upstream error: ' + fetchRes.statusCode);
                        });
                        return;
                    }
                    const ext = path.extname(fetchUrl).toLowerCase();
                    const responseHeaders = {
                        'Content-Type': MIME[ext] || 'application/octet-stream',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache'
                    };
                    if (fetchRes.headers['content-length']) responseHeaders['Content-Length'] = fetchRes.headers['content-length'];
                    if (fetchRes.headers['content-range']) responseHeaders['Content-Range'] = fetchRes.headers['content-range'];
                    if (req.headers.range) responseHeaders['Accept-Ranges'] = 'bytes';
                    console.log('[PROXY] status:', fetchRes.statusCode, 'size:', fetchRes.headers['content-length'] || 'chunked', 'time:', Date.now() - startTime + 'ms');
                    res.writeHead(fetchRes.statusCode, responseHeaders);
                    fetchRes.pipe(res);
                });
                fetchReq.on('error', (e) => {
                    console.error('[PROXY] fetch error:', e.message);
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Proxy error: ' + e.message);
                });
                fetchReq.end();
            }
            console.log('[PROXY]', req.headers.range ? 'RANGE' : 'FULL', targetUrl);
            doFetch(targetUrl, 0);
        } catch (e) {
            console.error('[PROXY] handler error:', e.message);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal proxy error');
        }
        return;
    }

    // POST /api/regenerate — WebDAV proxy if configured, else local scan
    if (method === 'POST' && url === '/api/regenerate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        try {
            if (webdavConfig) {
                const result = await webdavRequest('PROPFIND', webdavConfig.url, webdavConfig.auth);
                if (result.status >= 400) throw new Error('PROPFIND 失败: HTTP ' + result.status);
                const songs = parseWebdavFiles(result.data);
                fs.writeFileSync(path.join(ROOT, 'music.json'), JSON.stringify(songs, null, 2), 'utf8');
            } else {
                execSync('node scripts/generate-music-json.js', { cwd: ROOT, stdio: 'pipe' });
            }
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
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
    console.log(`API: /api/test-webdav, /api/sync-webdav, /api/proxy/*, /api/regenerate`);
});
