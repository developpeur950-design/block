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
// Symbole de lien : deux maillons de chaîne qui s'entrecroisent le long de la
// diagonale (contour, comme l'icône « lien » classique). Rien par-dessus.
function inLink(x, y) {
  const dx = x - 0.5, dy = y - 0.5;
  // Repère tourné à 45° : u le long de la diagonale, v perpendiculaire.
  const u = (dx + dy) / Math.SQRT2;
  const v = (dx - dy) / Math.SQRT2;
  const L = 0.08; // demi-longueur de chaque maillon
  const R = 0.11; // rayon du maillon
  const TH = 0.032; // épaisseur du trait
  const C = 0.17; // décalage des deux maillons le long de la diagonale
  const ringAt = (u0) => {
    const cu = Math.max(u0 - L, Math.min(u0 + L, u));
    const d = Math.sqrt((u - cu) * (u - cu) + v * v);
    return Math.abs(d - R) < TH;
  };
  return ringAt(C) || ringAt(-C);
}
function render(size) {
  const S = 4; // suréchantillonnage
  const rgba = Buffer.alloc(size * size * 4);
  const INK = [27, 27, 31]; // trait noir, fond transparent (comme l'image)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          if (inLink(x, y)) a += 255;
        }
      }
      const n = S * S;
      const i = (py * size + px) * 4;
      // Trait noir uniforme ; seul l'alpha varie (anti-aliasing + transparence).
      rgba[i] = INK[0];
      rgba[i + 1] = INK[1];
      rgba[i + 2] = INK[2];
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
