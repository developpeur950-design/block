#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Serveur de RÉCEPTION pour l'extension Garde-Redirections, en Python pur.
AUCUNE dépendance externe (pas de pip) : juste Python 3.8+.

Démarrage :  python server/server.py
Config : server/config.json (écrit par setup.py) ; variables d'environnement
prioritaires : PASSPHRASE, PORT, HOST, SERVER_KEY, DATA_DIR.

Le serveur ne fait que recevoir : il déchiffre (AES-256-GCM / PBKDF2) et écrit
un fichier JSON (tableau) par appareil. Visiter son adresse ne montre rien.
"""

import os
import re
import json
import time
import base64
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Config ----------------------------------------------------------
cfg = {}
try:
    with open(os.path.join(HERE, "config.json"), "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

PORT = int(os.environ.get("PORT") or cfg.get("port") or 8787)
HOST = os.environ.get("HOST") or cfg.get("host") or "127.0.0.1"
SERVER_KEY = os.environ.get("SERVER_KEY") or cfg.get("serverKey") or ""
PASSPHRASE = os.environ.get("PASSPHRASE") or cfg.get("passphrase") or ""
_data = os.environ.get("DATA_DIR") or cfg.get("dataDir") or "data"
DATA_DIR = _data if os.path.isabs(_data) else os.path.join(HERE, _data)

if not PASSPHRASE:
    raise SystemExit(
        "ERREUR : aucune phrase secrète.\n"
        "Lance d'abord :  python setup.py\n"
        'Ou :  PASSPHRASE="ma phrase" python server/server.py'
    )

os.makedirs(DATA_DIR, exist_ok=True)

# =====================================================================
# AES-256-GCM en Python pur (déchiffrement), compatible WebCrypto.
# =====================================================================

def _gf_mul(a, b):
    """Multiplication dans GF(2^8) (polynôme 0x11B)."""
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


def _rotl8(x, n):
    return ((x << n) | (x >> (8 - n))) & 0xFF


def _build_sbox():
    inv = [0] * 256
    for a in range(1, 256):
        # inverse = a^254 dans GF(2^8)
        r = 1
        for _ in range(254):
            r = _gf_mul(r, a)
        inv[a] = r
    sbox = [0] * 256
    for b in range(256):
        x = inv[b]
        sbox[b] = x ^ _rotl8(x, 1) ^ _rotl8(x, 2) ^ _rotl8(x, 3) ^ _rotl8(x, 4) ^ 0x63
    return sbox


SBOX = _build_sbox()
MUL2 = [_gf_mul(x, 2) for x in range(256)]
MUL3 = [_gf_mul(x, 3) for x in range(256)]
RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _key_expansion(key):
    """Clé 32 octets -> 60 mots (AES-256, 14 tours)."""
    Nk, Nr = 8, 14
    w = [list(key[4 * i:4 * i + 4]) for i in range(Nk)]
    for i in range(Nk, 4 * (Nr + 1)):
        t = list(w[i - 1])
        if i % Nk == 0:
            t = t[1:] + t[:1]
            t = [SBOX[x] for x in t]
            t[0] ^= RCON[i // Nk]
        elif i % Nk == 4:
            t = [SBOX[x] for x in t]
        w.append([w[i - Nk][j] ^ t[j] for j in range(4)])
    return w


def _encrypt_block(block, w):
    """Chiffre un bloc de 16 octets (AES-256)."""
    Nr = 14
    s = [[block[r + 4 * c] for c in range(4)] for r in range(4)]

    def add_rk(rnd):
        for c in range(4):
            for r in range(4):
                s[r][c] ^= w[rnd * 4 + c][r]

    add_rk(0)
    for rnd in range(1, Nr):
        # SubBytes
        for r in range(4):
            for c in range(4):
                s[r][c] = SBOX[s[r][c]]
        # ShiftRows
        for r in range(1, 4):
            s[r] = s[r][r:] + s[r][:r]
        # MixColumns
        for c in range(4):
            a0, a1, a2, a3 = s[0][c], s[1][c], s[2][c], s[3][c]
            s[0][c] = MUL2[a0] ^ MUL3[a1] ^ a2 ^ a3
            s[1][c] = a0 ^ MUL2[a1] ^ MUL3[a2] ^ a3
            s[2][c] = a0 ^ a1 ^ MUL2[a2] ^ MUL3[a3]
            s[3][c] = MUL3[a0] ^ a1 ^ a2 ^ MUL2[a3]
        add_rk(rnd)
    # Dernier tour (sans MixColumns)
    for r in range(4):
        for c in range(4):
            s[r][c] = SBOX[s[r][c]]
    for r in range(1, 4):
        s[r] = s[r][r:] + s[r][:r]
    add_rk(Nr)
    return bytes(s[r][c] for c in range(4) for r in range(4))


def _gmul128(x, y):
    """Multiplication dans GF(2^128) pour GHASH."""
    R = 0xE1 << 120
    z = 0
    v = y
    for i in range(128):
        if (x >> (127 - i)) & 1:
            z ^= v
        if v & 1:
            v = (v >> 1) ^ R
        else:
            v >>= 1
    return z


def _ghash(h, data):
    y = 0
    for i in range(0, len(data), 16):
        blk = data[i:i + 16]
        if len(blk) < 16:
            blk = blk + b"\x00" * (16 - len(blk))
        y ^= int.from_bytes(blk, "big")
        y = _gmul128(y, h)
    return y


def _inc32(block):
    pre = block[:12]
    ctr = (int.from_bytes(block[12:], "big") + 1) & 0xFFFFFFFF
    return pre + ctr.to_bytes(4, "big")


def _gctr(w, icb, data):
    out = bytearray()
    cb = icb
    for i in range(0, len(data), 16):
        ks = _encrypt_block(cb, w)
        chunk = data[i:i + 16]
        out += bytes(a ^ b for a, b in zip(chunk, ks))
        cb = _inc32(cb)
    return bytes(out)


def decrypt_envelope(env):
    """Déchiffre une enveloppe {salt, iv, ct} produite par l'extension."""
    if not isinstance(env, dict) or env.get("alg") != "AES-GCM":
        raise ValueError("enveloppe invalide")
    salt = base64.b64decode(env["salt"])
    iv = base64.b64decode(env["iv"])
    ctfull = base64.b64decode(env["ct"])
    if len(iv) != 12 or len(ctfull) < 16:
        raise ValueError("enveloppe invalide")
    ct, tag = ctfull[:-16], ctfull[-16:]
    it = int(env.get("iter") or 150000)
    key = hashlib.pbkdf2_hmac("sha256", PASSPHRASE.encode("utf-8"), salt, it, dklen=32)
    w = _key_expansion(key)
    h = int.from_bytes(_encrypt_block(b"\x00" * 16, w), "big")
    j0 = iv + b"\x00\x00\x00\x01"
    # Tag attendu
    s = _ghash(h, ct)
    lenblock = (0).to_bytes(8, "big") + (len(ct) * 8).to_bytes(8, "big")
    s ^= int.from_bytes(lenblock, "big")
    s = _gmul128(s, h)
    e0 = int.from_bytes(_encrypt_block(j0, w), "big")
    expected = (s ^ e0).to_bytes(16, "big")
    if expected != tag:
        raise ValueError("tag invalide")
    pt = _gctr(w, _inc32(j0), ct)
    return json.loads(pt.decode("utf-8"))


# =====================================================================
# Stockage (un fichier par appareil)
# =====================================================================

def safe(name):
    s = re.sub(r"[^a-z0-9_-]+", "_", (name or "inconnu").lower())[:60]
    return s or "inconnu"


def device_of(payload):
    tag = (payload.get("deviceTag") or "").strip()
    return tag or payload.get("clientId") or "inconnu"


def _row_json(it, meta, now):
    row = dict(it)
    row["deviceTag"] = meta.get("deviceTag") or ""
    row["clientId"] = meta.get("clientId") or "inconnu"
    row["receivedAt"] = now
    # JSON compact : aucun espace superflu.
    return json.dumps(row, ensure_ascii=False, separators=(",", ":"))


def append_items(kind, items, meta):
    """Ajoute des entrées à un fichier tableau JSON compact, en RAM minimale.

    On n'ouvre PAS tout le fichier : on remplace juste le « ] » final par
    « ,<nouvelles entrées>] ». Seuls quelques octets de fin sont lus.
    """
    if not isinstance(items, list) or not items:
        return 0
    path = os.path.join(DATA_DIR, safe(meta["device"]) + "." + kind + ".json")
    now = int(time.time() * 1000)
    payload = ",".join(_row_json(it, meta, now) for it in items).encode("utf-8")

    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0

    if size <= 0:
        with open(path, "wb") as f:
            f.write(b"[" + payload + b"]")
        return len(items)

    with open(path, "r+b") as f:
        back = min(size, 64)
        f.seek(size - back)
        tail = f.read(back)
        rb = tail.rfind(b"]")
        if rb == -1:
            # Fichier anormal (ne devrait pas arriver) : on repart proprement.
            f.seek(0)
            f.truncate()
            f.write(b"[" + payload + b"]")
            return len(items)
        close_pos = size - back + rb
        empty = tail[:rb].rstrip().endswith(b"[")
        f.seek(close_pos)
        f.truncate()
        f.write((b"" if empty else b",") + payload + b"]")
    return len(items)


def ts():
    return time.strftime("%H:%M:%S")


# =====================================================================
# Serveur HTTP (réception seule)
# =====================================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # on gère nos propres logs

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _send(self, code, obj=None):
        self.send_response(code)
        self._cors()
        if obj is None:
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
        else:
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(obj).encode("utf-8"))

    def do_GET(self):
        print(ts(), "GET", self.path, "-> 404 (le serveur ne fait que recevoir)")
        self._send(404, None)

    def do_POST(self):
        if self.path.split("?")[0] != "/collect":
            return self._send(404, None)
        if SERVER_KEY and self.headers.get("Authorization", "") != "Bearer " + SERVER_KEY:
            print(ts(), "POST /collect -> 401 REFUSÉ : jeton Bearer incorrect")
            return self._send(401, {"ok": False, "error": "non autorisé"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 20 * 1024 * 1024:  # garde-fou RAM : corps trop volumineux
                return self._send(413, {"ok": False, "error": "trop volumineux"})
            body = self.rfile.read(length) if length else b"{}"
            envelope = json.loads(body.decode("utf-8") or "{}")
            del body
        except Exception as e:
            return self._send(400, {"ok": False, "error": str(e)})
        try:
            payload = decrypt_envelope(envelope)
        except Exception:
            print(ts(), "POST /collect -> 400 REFUSÉ : déchiffrement impossible (phrase secrète ≠ extension)")
            return self._send(400, {"ok": False, "error": "déchiffrement impossible"})

        device = device_of(payload)
        meta = {"device": device, "deviceTag": payload.get("deviceTag"), "clientId": payload.get("clientId")}
        kind = payload.get("kind")
        saved = 0
        if kind == "visits":
            saved = append_items("visits", payload.get("items"), meta)
        elif kind == "history":
            saved = append_items("history", payload.get("items"), meta)
        print(ts(), 'POST /collect -> OK  %s  appareil="%s"  (+%d)' % (kind, device, saved))
        return self._send(200, {"ok": True, "kind": kind, "saved": saved})


def main():
    print("Garde-Redirections — serveur de RÉCEPTION (Python, privé, chiffré)")
    print("  Données      : " + DATA_DIR + "  (un fichier .json par appareil)")
    print("  Jeton Bearer : " + ("oui" if SERVER_KEY else "non"))
    print("  Chiffrement  : AES-256-GCM (PASSPHRASE requise)")

    hosts = [HOST]
    if HOST not in ("127.0.0.1", "localhost", "0.0.0.0"):
        hosts.append("127.0.0.1")

    # HTTPServer simple (pas un thread par requête) pour une RAM minimale.
    # Les envois de l'extension sont séquentiels : traiter une requête à la
    # fois suffit largement.
    servers = []
    for host in hosts:
        try:
            srv = HTTPServer((host, PORT), Handler)
        except OSError as e:
            print("  ⚠️  écoute %s:%d impossible : %s" % (host, PORT, e))
            continue
        servers.append(srv)
        print("  Écoute       : http://%s:%d/collect" % (host, PORT))

    if not servers:
        raise SystemExit("Aucune interface d'écoute disponible.")
    # Un serveur par interface : les secondaires tournent dans un thread léger,
    # le premier dans le thread principal.
    for srv in servers[1:]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")


if __name__ == "__main__":
    main()
