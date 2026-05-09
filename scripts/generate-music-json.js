const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.join(__dirname, '..', 'music');
const OUTPUT_FILE = path.join(__dirname, '..', 'music.json');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.aac']);
const COVER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const LRC_EXT = '.lrc';

const GITHUB_REPO = process.env.GITHUB_REPOSITORY || '';
const [OWNER, REPO] = GITHUB_REPO.split('/');
const CDN_BASE = OWNER && REPO
    ? `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}`
    : '';

function getBasename(filename) {
    const ext = path.extname(filename);
    return path.basename(filename, ext);
}

function scanMusicDir() {
    if (!fs.existsSync(MUSIC_DIR)) {
        console.error('Music directory not found:', MUSIC_DIR);
        return [];
    }

    const files = fs.readdirSync(MUSIC_DIR);

    const audioFiles = files.filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
    const coverFiles = files.filter(f => COVER_EXTS.has(path.extname(f).toLowerCase()));
    const lrcFiles = files.filter(f => path.extname(f).toLowerCase() === LRC_EXT);

    const coverMap = {};
    coverFiles.forEach(f => {
        const name = getBasename(f);
        coverMap[name] = f;
    });

    const lrcMap = {};
    lrcFiles.forEach(f => {
        const name = getBasename(f);
        lrcMap[name] = f;
    });

    const songs = audioFiles.map(audioFile => {
        const rawName = getBasename(audioFile);
        const ext = path.extname(audioFile);
        const cover = coverMap[rawName] || null;
        const lrc = lrcMap[rawName] || null;

        let songName = rawName;
        let artist = '未知';
        const dashIdx = rawName.lastIndexOf('-');
        if (dashIdx > 0 && dashIdx < rawName.length - 1) {
            songName = rawName.substring(0, dashIdx);
            artist = rawName.substring(dashIdx + 1);
        }

        const song = {
            name: songName,
            artist: artist
        };

        if (CDN_BASE) {
            song.url = `${CDN_BASE}/music/${encodeURIComponent(audioFile)}`;
            if (cover) song.cover = `${CDN_BASE}/music/${encodeURIComponent(cover)}`;
            if (lrc) song.lrc = `${CDN_BASE}/music/${encodeURIComponent(lrc)}`;
        } else {
            song.url = `music/${encodeURIComponent(audioFile)}`;
            if (cover) song.cover = `music/${encodeURIComponent(cover)}`;
            if (lrc) song.lrc = `music/${encodeURIComponent(lrc)}`;
        }

        return song;
    });

    songs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    return songs;
}

function main() {
    console.log('Scanning music directory...');
    const songs = scanMusicDir();
    console.log(`Found ${songs.length} songs.`);

    const json = JSON.stringify(songs, null, 2);
    fs.writeFileSync(OUTPUT_FILE, json, 'utf-8');
    console.log(`music.json generated at: ${OUTPUT_FILE}`);
}

main();
