const crypto = require('crypto');
const fs = require('fs');

const INPUT = 'webdav-config.enc';
const OUTPUT = 'webdav-config.json';
const PASS = process.env.CONFIG_PASS || process.env.WEBDAV_PASS || '';
const SALT = 'music-archive-salt';
const ITERATIONS = 100000;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

if (!PASS) {
    console.error('Error: No decryption password. Set CONFIG_PASS secret.');
    process.exit(1);
}

if (!fs.existsSync(INPUT)) {
    console.log('No encrypted config found, skipping.');
    process.exit(0);
}

try {
    const raw = fs.readFileSync(INPUT, 'utf8');
    const data = Buffer.from(raw, 'base64');
    const iv = data.subarray(0, IV_LEN);
    const tag = data.subarray(data.length - TAG_LEN);
    const ciphertext = data.subarray(IV_LEN, data.length - TAG_LEN);

    const key = crypto.pbkdf2Sync(PASS, SALT, ITERATIONS, KEY_LEN, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    fs.writeFileSync(OUTPUT, decrypted);
    console.log('Decrypted: webdav-config.json');
} catch (e) {
    console.error('Decryption failed:', e.message);
    process.exit(1);
}
