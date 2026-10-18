#!/usr/bin/env node
// Génère les icônes PNG de l'extension sans aucune dépendance (encodeur PNG
// minimal via zlib). Dessine un panneau d'interdiction blanc sur fond bleu.
//
//   node icons/generate-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// --- CRC32 / encodeur PNG (RGBA 8 bits) ------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filtre "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- Dessin (coordonnées normalisées 0..1), avec suréchantillonnage ---
function inRoundRect(x, y) {
  const min = 0.05, max = 0.95, r = 0.22;
  if (x < min || x > max || y < min || y > max) return false;
  const nx = x < min + r ? min + r : x > max - r ? max - r : x;
  const ny = y < min + r ? min + r : y > max - r ? max - r : y;
  const dx = x - nx, dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}
// Forme de bouclier (symbole de protection).
function inShield(x, y) {
  const cx = 0.5, top = 0.17, bot = 0.85, halfW = 0.27;
  if (y < top || y > bot) return false;
  const t = (y - top) / (bot - top); // 0 en haut, 1 à la pointe basse
  let w;
  if (t < 0.58) w = 1;
  else w = 1 - (t - 0.58) / 0.42; // se rétrécit vers la pointe
  if (t < 0.14) {
    // léger arrondi des épaules en haut
    const k = t / 0.14;
    w = Math.min(w, Math.sqrt(Math.max(0, 1 - (1 - k) * (1 - k))));
  }
  return Math.abs(x - cx) / halfW <= Math.max(0, w);
}
// Barre diagonale (slash) « \ » = blocage.
function inSlash(x, y) {
  return Math.abs(x - y) / Math.SQRT2 < 0.058;
}
function render(size) {
  const S = 4; // suréchantillonnage
  const rgba = Buffer.alloc(size * size * 4);
  const BLUE = [37, 99, 235];
  const WHITE = [255, 255, 255];
  const RED = [220, 38, 38];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          if (inRoundRect(x, y)) {
            let c = BLUE;
            if (inShield(x, y)) c = inSlash(x, y) ? RED : WHITE;
            r += c[0]; g += c[1]; b += c[2]; a += 255;
          }
        }
      }
      const n = S * S;
      const i = (py * size + px) * 4;
      // Moyenne des couleurs sur les seuls échantillons couverts (évite un
      // halo sombre sur les bords anti-aliasés).
      const cov = a / 255; // nombre d'échantillons couverts
      rgba[i] = cov ? Math.round(r / cov) : 0;
      rgba[i + 1] = cov ? Math.round(g / cov) : 0;
      rgba[i + 2] = cov ? Math.round(b / cov) : 0;
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

for (const size of [16, 32, 48, 128]) {
  const out = path.join(__dirname, "icon" + size + ".png");
  fs.writeFileSync(out, render(size));
  console.log("écrit " + out);
}
