#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Configuration en une commande (version Python, sans Node).

  python setup.py
  python setup.py --watch ma-banque.fr --watch mon-autre-site.fr

Détecte Tailscale, génère (ou réutilise) une phrase secrète + un jeton Bearer,
écrit server/config.json et extension/src/config.js.
"""

import os
import sys
import json
import socket
import secrets
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))


def take_all(flag):
    out = []
    a = sys.argv[1:]
    for i, v in enumerate(a):
        if v == flag and i + 1 < len(a):
            out.append(a[i + 1])
    return out


def take_one(flag, default=""):
    a = sys.argv[1:]
    if flag in a:
        i = a.index(flag)
        if i + 1 < len(a):
            return a[i + 1]
    return default


PORT = int(take_one("--port", "8787"))
WATCH = take_all("--watch")
ROTATE = "--rotate" in sys.argv
URL_OVERRIDE = take_one("--url", "")
HOST_OVERRIDE = take_one("--host", "")


def sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=8).stdout.strip()
    except Exception:
        return ""


def tailscale():
    ip, dns = "", ""
    out = sh(["tailscale", "ip", "-4"])
    if out:
        ip = out.split()[0]
    js = sh(["tailscale", "status", "--json"])
    if js:
        try:
            s = json.loads(js)
            self_ = s.get("Self", {})
            if self_.get("DNSName"):
                dns = self_["DNSName"].rstrip(".")
            if not ip and self_.get("TailscaleIPs"):
                v4 = [a for a in self_["TailscaleIPs"] if "." in a]
                ip = (v4 or self_["TailscaleIPs"])[0]
        except Exception:
            pass
    return ip, dns


ip, dns = tailscale()
if not ip and not dns and not URL_OVERRIDE:
    print(
        "⚠️  Tailscale introuvable (commande `tailscale` indisponible).\n"
        "   Installe Tailscale (https://tailscale.com/download) et connecte-toi,\n"
        "   puis relance `python setup.py`. Je continue avec 127.0.0.1 en attendant.\n"
    )

host = HOST_OVERRIDE or ip or "127.0.0.1"
if URL_OVERRIDE:
    base = URL_OVERRIDE
elif dns:
    base = "http://%s:%d" % (dns, PORT)
elif ip:
    base = "http://%s:%d" % (ip, PORT)
else:
    base = "http://localhost:%d" % PORT
server_url = URL_OVERRIDE or (base + "/collect")

# Secrets : réutilisés si déjà présents (sauf --rotate).
server_cfg_path = os.path.join(HERE, "server", "config.json")
prev = {}
try:
    with open(server_cfg_path, "r", encoding="utf-8") as f:
        prev = json.load(f)
except Exception:
    prev = {}

passphrase = prev.get("passphrase") if (not ROTATE and prev.get("passphrase")) else secrets.token_urlsafe(32)
server_key = prev.get("serverKey") if (not ROTATE and prev.get("serverKey")) else secrets.token_hex(24)
device_tag = socket.gethostname()

# Écriture serveur
os.makedirs(os.path.dirname(server_cfg_path), exist_ok=True)
server_cfg = {"port": PORT, "host": host, "serverKey": server_key, "passphrase": passphrase, "dataDir": "./data"}
with open(server_cfg_path, "w", encoding="utf-8") as f:
    json.dump(server_cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")

# Écriture extension
ext_cfg = {"serverUrl": server_url, "passphrase": passphrase, "serverKey": server_key,
           "deviceTag": device_tag, "watchedLinks": WATCH}
ext_cfg_path = os.path.join(HERE, "extension", "src", "config.js")
content = (
    "// Configuration INTÉGRÉE à l'extension — écrite par setup.py.\n"
    "// Ne pas committer : contient tes secrets.\n"
    "var GR_BAKED = " + json.dumps(ext_cfg, indent=2, ensure_ascii=False) + ";\n\n"
    'if (typeof self !== "undefined") self.GR_BAKED = GR_BAKED;\n'
)
with open(ext_cfg_path, "w", encoding="utf-8") as f:
    f.write(content)

# Récap
print("✅ Configuration terminée.\n")
print("  Serveur Tailscale")
print("    écoute sur    : %s:%d%s" % (host, PORT, "  (IP Tailscale)" if ip else ""))
print("    URL extension : " + server_url)
print("    MagicDNS      : " + (dns or "(non détecté)"))
print("    jeton Bearer  : " + server_key)
print("    appareil      : " + device_tag)
print("    sites protégés: " + (", ".join(WATCH) if WATCH else "(aucun — à ajouter dans les Options)"))
print("\n  Fichiers écrits")
print("    " + server_cfg_path)
print("    " + ext_cfg_path)
print("\n  Étapes suivantes")
print("    1) Démarre le serveur :  python server/server.py")
print("    2) Charge / recharge l'extension (dossier extension/).")
if not ip and not dns and not URL_OVERRIDE:
    print("\n  ⚠️  Installe Tailscale puis relance `python setup.py`.")
