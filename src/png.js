'use strict';

const {deflateSync, inflateSync} = require('node:zlib');

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
}

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function u32be(n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    data.copy(out, 8);
    const crc = crc32(out.subarray(4, 8 + data.length));
    out.writeUInt32BE(crc, 8 + data.length);
    return out;
}

function encodePng(rgba, width, height) {
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const src = y * width * 4;
        const dst = y * (1 + width * 4);
        raw[dst] = 0;
        rgba.copy(raw, dst + 1, src, src + width * 4);
    }
    const ihdr = Buffer.from([
        ...u32be(width), ...u32be(height),
        8, 6, 0, 0, 0,
    ]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, {level: 6})),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function decodePng(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
        throw new Error('not a PNG');
    }
    let off = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idats = [];
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idats.push(data);
        } else if (type === 'IEND') {
            break;
        }
        off += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (depth ${bitDepth} type ${colorType} interlace ${interlace})`);
    }
    const bpp = colorType === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(idats));
    const stride = width * bpp;
    const rgba = Buffer.alloc(width * height * 4);
    let src = 0;
    const prev = Buffer.alloc(stride);
    const row = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[src++];
        raw.copy(row, 0, src, src + stride);
        src += stride;
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? row[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let x = row[i];
            if (filter === 1) x = (x + a) & 255;
            else if (filter === 2) x = (x + b) & 255;
            else if (filter === 3) x = (x + ((a + b) >> 1)) & 255;
            else if (filter === 4) x = (x + paeth(a, b, c)) & 255;
            else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
            row[i] = x;
        }
        row.copy(prev, 0, 0, stride);
        for (let x = 0; x < width; x++) {
            const di = (y * width + x) * 4;
            const si = x * bpp;
            rgba[di] = row[si];
            rgba[di + 1] = row[si + 1];
            rgba[di + 2] = row[si + 2];
            rgba[di + 3] = bpp === 4 ? row[si + 3] : 255;
        }
    }
    return {rgba, width, height};
}

module.exports = {encodePng, decodePng};
