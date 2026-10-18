#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Génère les icônes PNG de l'extension sans aucune dépendance (encodeur PNG via
zlib, inclus dans Python). Dessine un symbole de lien (deux maillons entrelacés),
trait noir sur fond transparent.

  python extension/icons/generate_icons.py
"""

import os
import zlib
import struct
import math

HERE = os.path.dirname(os.path.abspath(__file__))


def encode_png(width, height, rgba):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # RGBA 8 bits
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filtre "none"
        raw += rgba[y * stride:(y + 1) * stride]
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def in_link(x, y):
    """Deux maillons de chaîne entrelacés le long de la diagonale (contour)."""
    dx, dy = x - 0.5, y - 0.5
    u = (dx + dy) / math.sqrt(2)
    v = (dx - dy) / math.sqrt(2)
    L, R, TH, C = 0.08, 0.11, 0.032, 0.17

    def ring_at(u0):
        cu = max(u0 - L, min(u0 + L, u))
        d = math.sqrt((u - cu) ** 2 + v * v)
        return abs(d - R) < TH

    return ring_at(C) or ring_at(-C)


def render(size):
    S = 4  # suréchantillonnage
    ink = (27, 27, 31)
    out = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            a = 0
            for sy in range(S):
                for sx in range(S):
                    x = (px + (sx + 0.5) / S) / size
                    y = (py + (sy + 0.5) / S) / size
                    if in_link(x, y):
                        a += 255
            i = (py * size + px) * 4
            out[i] = ink[0]
            out[i + 1] = ink[1]
            out[i + 2] = ink[2]
            out[i + 3] = round(a / (S * S))
    return encode_png(size, size, out)


if __name__ == "__main__":
    for size in (16, 32, 48, 128):
        path = os.path.join(HERE, "icon%d.png" % size)
        with open(path, "wb") as f:
            f.write(render(size))
        print("écrit " + path)
