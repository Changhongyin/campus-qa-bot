#!/usr/bin/env python3
"""Render the "Liangda Zhida" easter-egg film against the anthem.

A campus anime short, painted in code in the manner of Makoto Shinkai's films:
huge skies and lit clouds, golden-hour light, bloom and lens flares, window
frames, cherry blossoms, power lines, a level crossing, the river at dusk and a
night of stars. One student carries it, and the second verse becomes the motto
精思国计，细量民生 told without words: she measures something small with great
care (细量), then looks out over the city and the sky (精思国计), and the stars
turn into the graduated circle of the final "计量".

There is no text in the film. Every section boundary is a measured time in the
anthem (CUES below), the anthem's loudness drives the light, and the duration
is the anthem's, frame for frame.

Usage:
  python scripts/easteregg/render_film.py --audio public/media/anthem.mp3 \\
      --out-dir public/media [--workers 4] [--preview 30 70 158]

Requires: ffmpeg, numpy, pillow, skia-python.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import skia
from PIL import Image, ImageFilter

W, H = 1920, 1080
CX, CY = W / 2, H / 2
FPS = 30
GLOW_SCALE = 4  # bloom is painted at 1/4 size, blurred, then added back

# Measured in the supplied anthem (seconds). See README "Easter Egg Integration".
CUES = {
    "intro_in": 0.60,     # first sound
    "prelude": 3.30,      # orchestral prelude
    "verse1": 21.00,      # "...钱塘江 那是我们学习的地方"
    "spring": 41.50,      # "...春风吹 ... 开放"
    "nation": 61.50,      # "...中心是祖国 ... 力量"
    "interlude": 81.60,   # instrumental bridge
    "verse2": 92.00,      # "...成长的地方"
    "lattice": 112.50,    # "...国家 ... 方向 ... 永远的梦"
    "converge": 141.00,   # "...校园 ... 力量 ... 我的名字叫"
    "ji": 158.10,         # 计 sung
    "liang": 162.05,      # 量 sung
    "sung_end": 169.25,   # 量 released (reverb tail ends)
}

# Character palette (cel base, cel shade).
SKIN = ((250, 222, 200), (214, 160, 140))
HAIR = ((58, 40, 44), (30, 20, 30))
SHIRT = ((246, 244, 240), (178, 182, 206))
BLAZER = ((44, 54, 88), (24, 28, 52))
SKIRT = ((40, 46, 74), (22, 24, 44))
SOCKS = ((34, 34, 46), (18, 18, 26))
SHOES = ((92, 58, 44), (48, 30, 26))
RIBBON = ((214, 62, 52), (150, 34, 40))
BRASS = (226, 180, 92)
PAPER = (246, 238, 222)
VERMILION = (217, 71, 43)
NIGHT = (6, 9, 22)


# ---------------------------------------------------------------- helpers
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = clamp(x)
    return 0.5 - 0.5 * math.cos(math.pi * x)


def lerp(a, b, k):
    return a + (b - a) * k


def mix(c1, c2, k):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * clamp(k))) for i in range(3))


def color(rgb, a=1.0):
    return skia.ColorSetARGB(int(clamp(a) * 255), *rgb)


def fill(rgb, a=1.0):
    return skia.Paint(AntiAlias=True, Color=color(rgb, a), Style=skia.Paint.kFill_Style)


def stroke(rgb, a, width, cap=skia.Paint.kRound_Cap):
    p = skia.Paint(AntiAlias=True, Color=color(rgb, a), Style=skia.Paint.kStroke_Style, StrokeWidth=width)
    p.setStrokeCap(cap)
    p.setStrokeJoin(skia.Paint.kRound_Join)
    return p


def additive(p):
    p.setBlendMode(skia.BlendMode.kPlus)
    return p


def vgrad(c, top, bottom, rgb_stops, rect=None):
    """Vertical gradient fill. rgb_stops: [(pos, rgb), ...]."""
    shader = skia.GradientShader.MakeLinear(
        points=[(0, top), (0, bottom)],
        colors=[color(rgb) for _, rgb in rgb_stops],
        positions=[p for p, _ in rgb_stops])
    c.drawRect(rect or skia.Rect.MakeLTRB(0, top, W, bottom), skia.Paint(Shader=shader))


def radial(c, x, y, r, rgb, a, add=True):
    if a <= 0.003 or r <= 1:
        return
    shader = skia.GradientShader.MakeRadial(
        center=(x, y), radius=r,
        colors=[color(rgb, a), color(rgb, a * 0.32), color(rgb, 0)], positions=[0.0, 0.4, 1.0])
    p = skia.Paint(AntiAlias=True, Shader=shader)
    if add:
        additive(p)
    c.drawCircle(x, y, r, p)


def poly(points, close=True):
    path = skia.Path()
    path.addPoly([skia.Point(float(x), float(y)) for x, y in points], close)
    return path


def capsule(x0, y0, x1, y1, r0, r1):
    """A tapered limb from (x0, y0) radius r0 to (x1, y1) radius r1."""
    ang = math.atan2(y1 - y0, x1 - x0)
    nx, ny = -math.sin(ang), math.cos(ang)
    path = skia.Path()
    path.moveTo(x0 + nx * r0, y0 + ny * r0)
    path.lineTo(x1 + nx * r1, y1 + ny * r1)
    path.arcTo(skia.Rect.MakeLTRB(x1 - r1, y1 - r1, x1 + r1, y1 + r1), math.degrees(ang) + 90, -180, False)
    path.lineTo(x0 - nx * r0, y0 - ny * r0)
    path.arcTo(skia.Rect.MakeLTRB(x0 - r0, y0 - r0, x0 + r0, y0 + r0), math.degrees(ang) - 90, -180, False)
    path.close()
    return path


def cel(c, path, tone, light, rim=None, rim_a=0.0):
    """Two-tone cel shading: base, a shade band away from the light, an optional rim of light."""
    base, shade = tone
    c.drawPath(path, fill(base))
    c.save()
    c.clipPath(path, skia.ClipOp.kIntersect, True)
    c.save()
    c.translate(light[0], light[1])
    c.drawPath(path, fill(shade))
    c.restore()
    if rim and rim_a > 0:
        p = stroke(rim, rim_a, 0.09)  # in head units: a fine line of light
        c.save()
        c.translate(-light[0] * 0.25, -light[1] * 0.25)
        c.drawPath(path, p)
        c.restore()
    c.restore()


def layer(c, alpha):
    if alpha >= 0.999:
        c.save()
    else:
        c.saveLayerAlpha(None, int(clamp(alpha) * 255))


# ---------------------------------------------------------------- textures
def noise(w, h, seed, octaves=6, cell=256, persistence=0.55):
    """Fractal value noise (square cells, bicubic), roughly 0..1."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for _ in range(octaves):
        size = max(2, int(cell))
        gw, gh = w // size + 3, h // size + 3
        grid = (rng.random((gh, gw)) * 255).astype(np.uint8)
        img = Image.fromarray(grid).resize((gw * size, gh * size), Image.BICUBIC)
        out += amp * np.asarray(img, np.float32)[size: size + h, size: size + w] / 255
        total += amp
        amp *= persistence
        cell /= 2
    return out / total


def to_image(rgb, alpha):
    arr = np.dstack([np.clip(rgb, 0, 255), np.clip(alpha * 255, 0, 255)]).astype(np.uint8)
    return skia.Image.fromarray(np.ascontiguousarray(arr), colorType=skia.kRGBA_8888_ColorType,
                                alphaType=skia.kUnpremul_AlphaType)


def make_clouds(w, h, seed, lit, shade, rim, band=(0.25, 0.75), cover=0.5, sun_dir=(0.0, -1.0), scale=1.0):
    """Towering cumulus with flat bases, lit from the sun's side, with a bright silver lining."""
    mass = noise(w, h, seed, octaves=3, cell=520 * scale, persistence=0.5)
    detail = noise(w, h, seed + 1, octaves=5, cell=200 * scale, persistence=0.5)
    ys = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    lo, hi = band
    v = np.clip((ys - lo) / (hi - lo), -1, 2)               # 0 at the tops, 1 at the bases
    d = mass * 1.15 + detail * 0.55 - (1 - v) * 0.75 - 0.35 * (1 - cover)
    d *= np.clip((1.0 - v) / 0.12, 0, 1)                    # flat bases
    d *= np.clip(v / 0.05 + 0.2, 0, 1)
    alpha = np.clip((d - 0.38) / 0.08, 0, 1)
    # light from a blurred density, shifted toward the sun with edge padding (no wrap-around)
    soft = np.asarray(Image.fromarray(np.clip(d * 255, 0, 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(14)), np.float32) / 255
    sx, sy = sun_dir
    norm = math.hypot(sx, sy) or 1
    oy, ox = int(round(sy / norm * 34)), int(round(sx / norm * 34))
    pad = np.pad(soft, ((abs(oy), abs(oy)), (abs(ox), abs(ox))), mode="edge")
    toward = pad[abs(oy) + oy: abs(oy) + oy + h, abs(ox) + ox: abs(ox) + ox + w]
    light = np.clip((soft - toward) * 7 + 0.42 + 0.4 * (1 - np.clip(v, 0, 1)), 0, 1)
    light = light * light * (3 - 2 * light)
    edge = np.clip(alpha * (1 - alpha) * 4, 0, 1) * np.clip(light * 1.6, 0, 1)
    lit, shade, rim = (np.array(x, np.float32) for x in (lit, shade, rim))
    rgb = shade + (lit - shade) * light[..., None]
    rgb = rgb + (rim - rgb) * (edge[..., None] * 0.9)
    return to_image(rgb, alpha * 0.98)


def make_city(w, h, seed, base_rgb, light_rgb, lights=0.6, max_h=0.8, min_h=0.25, density=1.0):
    """A skyline strip with lit windows (an RGBA image, transparent sky)."""
    rng = np.random.default_rng(seed)
    surf = skia.Surface(w, h)
    c = surf.getCanvas()
    c.clear(skia.ColorTRANSPARENT)
    x = -20
    while x < w:
        bw = rng.integers(30, 110)
        bh = h * rng.uniform(min_h, max_h) * (0.6 + 0.4 * math.sin(x / w * 7 + seed))
        c.drawRect(skia.Rect.MakeXYWH(x, h - bh, bw, bh), fill(base_rgb))
        if rng.random() < 0.15:
            c.drawRect(skia.Rect.MakeXYWH(x + bw / 2 - 2, h - bh - 30, 4, 30), fill(base_rgb))
            c.drawCircle(x + bw / 2, h - bh - 30, 2.5, fill(VERMILION, 0.9))
        if lights > 0:
            for wy in range(int(h - bh + 8), h - 4, 9):
                for wx in range(int(x + 5), int(x + bw - 6), 8):
                    if rng.random() < lights * 0.35 * density:
                        c.drawRect(skia.Rect.MakeXYWH(wx, wy, 4, 3),
                                   fill(mix(light_rgb, PAPER, rng.random() * 0.5), 0.55 + 0.45 * rng.random()))
        x += bw + rng.integers(-6, 8)
    return surf.makeImageSnapshot()


def make_milky_way(w, h, seed):
    n = noise(w, h, seed, octaves=7, cell=420, persistence=0.6)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    band = np.exp(-(((yy - h * 0.15) - (xx - w * 0.5) * 0.45) / (h * 0.16)) ** 2)
    a = np.clip((n - 0.38) * 2.2, 0, 1) * band
    rgb = np.dstack([170 + 60 * n, 160 + 50 * n, 230 + 20 * n])
    return to_image(rgb, a * 0.55)


# ---------------------------------------------------------------- audio
def loudness_envelope(audio, duration):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", audio, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
                         check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    frames = int(round(duration * FPS))
    hop = 8000 / FPS
    env = np.zeros(frames)
    for i in range(frames):
        seg = x[int(i * hop):int((i + 1) * hop)]
        env[i] = math.sqrt(float(np.mean(seg * seg))) if len(seg) else 0.0
    norm = np.clip((20 * np.log10(env + 1e-6) + 42) / 30, 0, 1)
    out, level = np.zeros(frames), 0.0
    for i, v in enumerate(norm):
        level += (v - level) * (0.25 if v > level else 0.04)
        out[i] = level
    return out


def media_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
                         check=True, capture_output=True, text=True).stdout
    return float(json.loads(out)["format"]["duration"])


# ---------------------------------------------------------------- the student
class Student:
    """A cel-shaded anime student, posed from joint angles. Units: one head = 1."""

    def __init__(self):
        self.wind = 0.0
        self.t = 0.0

    # -- poses ------------------------------------------------------------
    @staticmethod
    def stand():
        return dict(torso=0, neck=0, head=0, thigh_n=0, shin_n=0, thigh_f=0, shin_f=0,
                    arm_n=8, fore_n=6, arm_f=-6, fore_f=4, bob=0, skirt=0)

    @staticmethod
    def walk(phase, stride=1.0, run=0.0):
        s = math.sin(phase)
        k = 1 + run * 0.8
        p = Student.stand()
        p.update(
            torso=4 + 10 * run,
            thigh_n=26 * s * stride * k, thigh_f=-26 * s * stride * k,
            shin_n=-max(0.0, 40 * math.sin(phase + 1.2)) * stride * k,
            shin_f=-max(0.0, 40 * math.sin(phase + 1.2 + math.pi)) * stride * k,
            arm_n=-24 * s * stride * k, arm_f=24 * s * stride * k,
            fore_n=18 + 30 * run, fore_f=18 + 30 * run,
            bob=abs(math.cos(phase)) * 0.09 * stride * k, skirt=6 * s * stride)
        return p

    @staticmethod
    def blend(a, b, k):
        return {key: lerp(a[key], b[key], k) for key in a}

    # -- drawing ----------------------------------------------------------
    def side(self, c, x, y, s, pose, facing=1, light=(-1, -0.4), rim=None, rim_a=0.0, tone=1.0):
        """Side view; (x, y) is the ground point under the hips, s pixels per head."""
        c.save()
        c.translate(x, y)
        c.scale(facing * s, s)
        lx, ly = light[0] * facing * 0.09, light[1] * 0.09
        L = (lx, ly)
        A = math.radians
        hip = (0.0, -3.6 + pose["bob"])
        tor = A(pose["torso"])
        neck = (hip[0] + math.sin(tor) * 2.45, hip[1] - math.cos(tor) * 2.45)

        def limb(origin, a1, a2, l1, l2):
            k1 = (origin[0] + math.sin(A(a1)) * l1, origin[1] + math.cos(A(a1)) * l1)
            k2 = (k1[0] + math.sin(A(a1 + a2)) * l2, k1[1] + math.cos(A(a1 + a2)) * l2)
            return k1, k2

        def leg(th, sh, near):
            knee, ankle = limb(hip, th, sh, 1.8, 1.75)
            t = SOCKS if near else (tuple(int(v * 0.8) for v in SOCKS[0]), SOCKS[1])
            cel(c, capsule(hip[0], hip[1], knee[0], knee[1], 0.3, 0.2), SKIN if near else (SKIN[1], SKIN[1]), L)
            cel(c, capsule(knee[0], knee[1], ankle[0], ankle[1], 0.21, 0.15), t, L)
            fa = A(th + sh)
            toe = (ankle[0] + math.cos(fa) * 0.48, ankle[1] - math.sin(fa) * 0.1 + 0.05)
            cel(c, capsule(ankle[0], ankle[1] + 0.04, toe[0], toe[1], 0.15, 0.13), SHOES, L)

        def arm(a1, a2, near):
            sh = (neck[0] + math.sin(tor) * -0.3, neck[1] + 0.35)
            elbow, wrist = limb(sh, -a1, -a2, 1.25, 1.15)
            sleeve = BLAZER if near else (BLAZER[1], BLAZER[1])
            cel(c, capsule(sh[0], sh[1], elbow[0], elbow[1], 0.24, 0.19), sleeve, L)
            cel(c, capsule(elbow[0], elbow[1], wrist[0], wrist[1], 0.19, 0.16), sleeve, L)
            cel(c, capsule(wrist[0], wrist[1], wrist[0] + math.sin(A(-a1 - a2)) * 0.32,
                           wrist[1] + math.cos(A(-a1 - a2)) * 0.32, 0.12, 0.1), SKIN, L)

        arm(pose["arm_f"], pose["fore_f"], False)
        leg(pose["thigh_f"], pose["shin_f"], False)
        # skirt: a pleated trapezoid swinging with the stride and the wind
        sk = A(pose["skirt"] + self.wind * 8 * math.sin(self.t * 2.3))
        skirt = poly([(hip[0] - 0.55, hip[1] - 0.35), (hip[0] + 0.55, hip[1] - 0.35),
                      (hip[0] + 0.95 + math.sin(sk) * 0.6, hip[1] + 1.25),
                      (hip[0] - 0.85 + math.sin(sk) * 0.6 - self.wind * 0.25, hip[1] + 1.3)])
        cel(c, skirt, SKIRT, L, rim, rim_a)
        leg(pose["thigh_n"], pose["shin_n"], True)
        # torso: blazer over shirt
        body = skia.Path()
        bx, by = hip
        nx, ny = neck
        body.moveTo(bx - 0.62, by - 0.2)
        body.cubicTo(bx - 0.75, by - 1.2, nx - 0.78, ny + 0.9, nx - 0.5, ny + 0.15)
        body.lineTo(nx + 0.42, ny + 0.15)
        body.cubicTo(nx + 0.75, ny + 0.9, bx + 0.7, by - 1.0, bx + 0.6, by - 0.2)
        body.close()
        cel(c, body, BLAZER, L, rim, rim_a)
        collar = poly([(nx - 0.05, ny + 0.12), (nx + 0.42, ny + 0.16), (nx + 0.3, ny + 0.85)])
        cel(c, collar, SHIRT, L)
        rib = poly([(nx + 0.3, ny + 0.3), (nx + 0.62, ny + 0.55), (nx + 0.38, ny + 0.62)])
        cel(c, rib, RIBBON, L)
        arm(pose["arm_n"], pose["fore_n"], True)
        self.head_side(c, nx, ny, pose["neck"] + pose["torso"] * 0.5 + pose["head"], L, rim, rim_a)
        c.restore()

    def head_side(self, c, nx, ny, tilt, L, rim, rim_a):
        c.save()
        c.translate(nx, ny)
        c.rotate(tilt)
        cel(c, capsule(0, 0.1, 0.05, -0.45, 0.16, 0.16), SKIN, L)
        hx, hy = 0.12, -0.98
        face = skia.Path()
        face.moveTo(hx - 0.5, hy - 0.2)
        face.cubicTo(hx - 0.5, hy - 0.75, hx + 0.5, hy - 0.8, hx + 0.52, hy - 0.15)
        face.lineTo(hx + 0.58, hy + 0.05)   # brow to nose
        face.lineTo(hx + 0.52, hy + 0.2)
        face.cubicTo(hx + 0.5, hy + 0.45, hx + 0.25, hy + 0.62, hx + 0.02, hy + 0.6)
        face.cubicTo(hx - 0.35, hy + 0.55, hx - 0.5, hy + 0.3, hx - 0.5, hy - 0.2)
        face.close()
        cel(c, face, SKIN, L)
        # the anime eye: tall iris, a highlight, a lash line
        ex, ey = hx + 0.32, hy - 0.02
        c.drawPath(poly([(ex - 0.08, ey - 0.16), (ex + 0.1, ey - 0.15), (ex + 0.08, ey + 0.14), (ex - 0.07, ey + 0.13)]),
                   fill((70, 48, 60)))
        c.drawCircle(ex + 0.02, ey + 0.02, 0.055, fill((150, 110, 96)))
        c.drawCircle(ex - 0.01, ey - 0.07, 0.035, fill(PAPER))
        c.drawLine(ex - 0.12, ey - 0.17, ex + 0.14, ey - 0.15, stroke((40, 26, 34), 1, 0.05))
        c.drawCircle(hx + 0.28, hy + 0.27, 0.07, fill((240, 150, 150), 0.45))  # blush
        # hair: long locks behind, then the crown, then the bangs; the locks move in the wind
        for i in range(5):
            sway = self.wind * (0.12 + 0.04 * i) * math.sin(self.t * (1.5 + 0.23 * i) + i * 1.3)
            rx, ry = hx - 0.5 + i * 0.07, hy - 0.45 + i * 0.16
            tip = (rx - 0.18 - self.wind * (0.35 + 0.08 * i) + sway, hy + 1.15 - abs(i - 2) * 0.08)
            lock = skia.Path()
            lock.moveTo(rx + 0.22, ry)
            lock.cubicTo(rx + 0.15, ry + 0.6, tip[0] + 0.25, tip[1] - 0.4, *tip)
            lock.cubicTo(tip[0] - 0.05, tip[1] - 0.5, rx - 0.22, ry + 0.5, rx - 0.12, ry)
            lock.close()
            cel(c, lock, HAIR, L, rim, rim_a)
        crown = skia.Path()
        crown.moveTo(hx + 0.55, hy - 0.2)
        crown.cubicTo(hx + 0.62, hy - 1.05, hx - 0.78, hy - 1.05, hx - 0.64, hy - 0.05)
        crown.cubicTo(hx - 0.62, hy + 0.35, hx - 0.45, hy + 0.6, hx - 0.3, hy + 0.7)
        crown.lineTo(hx - 0.02, hy + 0.15)
        crown.cubicTo(hx + 0.12, hy - 0.3, hx + 0.35, hy - 0.4, hx + 0.55, hy - 0.2)
        crown.close()
        cel(c, crown, HAIR, L, rim, rim_a)
        bang = skia.Path()
        bang.moveTo(hx + 0.55, hy - 0.25)
        bang.quadTo(hx + 0.62 + self.wind * 0.04 * math.sin(self.t * 3), hy - 0.02, hx + 0.48, hy + 0.12)
        bang.quadTo(hx + 0.42, hy - 0.2, hx + 0.2, hy - 0.4)
        bang.close()
        cel(c, bang, HAIR, L, rim, rim_a)
        c.drawLine(hx - 0.1, hy - 0.62, hx + 0.3, hy - 0.55, stroke(PAPER, 0.35, 0.05))  # hair sheen
        c.restore()

    def back(self, c, x, y, s, sit=False, arm_up=0.0, look_up=0.0, light=(0, -1), rim=None, rim_a=0.0):
        """Back view, standing or sitting on the ground; arm_up lifts the right hand to the sky."""
        c.save()
        c.translate(x, y)
        c.scale(s, s)
        L = (light[0] * 0.09, light[1] * 0.09)
        hip_y = -0.4 if sit else -3.6
        if sit:
            # knees drawn up, feet tucked: only a soft mound shows from behind
            cel(c, poly([(-1.1, 0), (-0.9, -0.7), (0.9, -0.7), (1.1, 0)]), SKIRT, L, rim, rim_a)
        else:
            for sx in (-0.33, 0.33):
                cel(c, capsule(sx, hip_y + 0.4, sx * 1.1, -0.35, 0.24, 0.16), SKIN, L)
                cel(c, capsule(sx * 1.1, -1.4, sx * 1.1, -0.3, 0.17, 0.15), SOCKS, L)
                cel(c, capsule(sx * 1.1 - 0.12, -0.08, sx * 1.1 + 0.12, -0.08, 0.15, 0.15), SHOES, L)
            sk = self.wind * 0.3 * math.sin(self.t * 2.1)
            cel(c, poly([(-0.62, hip_y - 0.35), (0.62, hip_y - 0.35), (0.9 + sk, hip_y + 1.25),
                         (-0.88 + sk, hip_y + 1.3)]), SKIRT, L, rim, rim_a)
        ny = hip_y - 2.45
        body = skia.Path()
        body.moveTo(-0.66, hip_y - 0.2)
        body.cubicTo(-0.8, hip_y - 1.3, -0.95, ny + 0.6, -0.55, ny + 0.12)
        body.lineTo(0.55, ny + 0.12)
        body.cubicTo(0.95, ny + 0.6, 0.8, hip_y - 1.3, 0.66, hip_y - 0.2)
        body.close()
        cel(c, body, BLAZER, L, rim, rim_a)
        # left arm down, right arm lifting toward the sky
        cel(c, capsule(-0.78, ny + 0.4, -0.92, ny + 2.0, 0.22, 0.17), BLAZER, L, rim, rim_a)
        cel(c, capsule(-0.92, ny + 2.0, -0.95, ny + 2.3, 0.13, 0.11), SKIN, L)
        a = math.radians(lerp(8, 150, ease_in_out(arm_up)))
        ex, ey = 0.78 + math.sin(a) * 1.25, ny + 0.4 + math.cos(a) * 1.25
        wx, wy = ex + math.sin(a * 1.05) * 1.1, ey + math.cos(a * 1.05) * 1.1
        cel(c, capsule(0.78, ny + 0.4, ex, ey, 0.22, 0.18), BLAZER, L, rim, rim_a)
        cel(c, capsule(ex, ey, wx, wy, 0.18, 0.15), BLAZER, L, rim, rim_a)
        cel(c, capsule(wx, wy, wx + math.sin(a) * 0.3, wy + math.cos(a) * 0.3, 0.12, 0.1), SKIN, L)
        # head from behind: all hair, lifting slightly when looking up
        c.save()
        c.translate(0, ny)
        c.rotate(-6 * look_up)
        hy = -0.95 + 0.12 * look_up
        cel(c, capsule(0, 0.05, 0, -0.45, 0.17, 0.17), SKIN, L)
        head = skia.Path()
        head.addOval(skia.Rect.MakeLTRB(-0.6, hy - 0.72, 0.6, hy + 0.6))
        cel(c, head, HAIR, L, rim, rim_a)
        for i in range(9):
            u = -0.6 + i * 0.15
            sway = self.wind * 0.22 * math.sin(self.t * (1.6 + 0.17 * i) + i * 0.8)
            strand = skia.Path()
            strand.moveTo(u - 0.1, hy)
            strand.quadTo(u * 1.15 + sway * 0.5, hy + 0.8, u * 1.05 + sway, hy + 1.35 - abs(u) * 0.3)
            strand.quadTo(u * 1.1 + 0.05, hy + 0.7, u + 0.12, hy)
            strand.close()
            cel(c, strand, HAIR, L, rim, rim_a)
        c.restore()
        c.restore()


# ---------------------------------------------------------------- world
class Film:
    def __init__(self, env, duration):
        self.env = env
        self.duration = duration
        self.surface = skia.Surface(W, H)
        self.glow = skia.Surface(W // GLOW_SCALE, H // GLOW_SCALE)
        self.scratch = skia.Surface(W, H)
        self.blur = {s: skia.MaskFilter.MakeBlur(skia.kNormal_BlurStyle, s) for s in (1, 2, 4, 8, 16)}
        self.girl = Student()
        rng = np.random.default_rng(1978)  # the year the school was founded
        self.rng = rng
        self.petals = rng.random((420, 6))
        self.motes = rng.random((160, 4))
        self.stars = rng.random((900, 4))
        self.bokeh = rng.random((70, 5))
        self.birds = rng.random((14, 3))
        # painted once, moved per frame
        self.clouds_gold = make_clouds(W + 900, 760, 11, lit=(255, 236, 196), shade=(216, 140, 118),
                                       rim=(255, 250, 230), band=(0.18, 0.92), cover=0.55, sun_dir=(0.6, 0.4))
        self.clouds_dusk = make_clouds(W + 900, 640, 23, lit=(255, 196, 150), shade=(132, 92, 140),
                                       rim=(255, 236, 200), band=(0.15, 0.9), cover=0.52, sun_dir=(0.9, 0.3))
        self.clouds_day = make_clouds(W + 900, 700, 37, lit=(255, 255, 255), shade=(170, 190, 226),
                                      rim=(255, 255, 255), band=(0.2, 0.95), cover=0.66, sun_dir=(-0.3, -1))
        self.clouds_eve = make_clouds(W + 900, 620, 41, lit=(255, 170, 120), shade=(96, 70, 120),
                                      rim=(255, 220, 170), band=(0.15, 0.85), cover=0.48, sun_dir=(0, 1))
        self.clouds_blue = make_clouds(W + 900, 520, 53, lit=(236, 160, 176), shade=(58, 52, 104),
                                       rim=(255, 200, 200), band=(0.2, 0.8), cover=0.42, sun_dir=(0, 1))
        self.city_dusk = make_city(W + 600, 220, 5, (40, 34, 60), (255, 210, 150), lights=0.25)
        self.city_far = make_city(W + 400, 160, 6, (70, 60, 92), (255, 220, 170), lights=0.15, max_h=0.7)
        self.city_night = make_city(W + 600, 300, 7, (14, 18, 40), (255, 214, 150), lights=1.0, max_h=0.9)
        self.city_night_far = make_city(W + 600, 200, 8, (22, 26, 56), (210, 220, 255), lights=0.9, max_h=0.6)
        self.milky = make_milky_way(W, H, 99)

    def energy(self, t):
        return float(self.env[int(clamp(t * FPS, 0, len(self.env) - 1))])

    # -- shared pieces ----------------------------------------------------
    def draw_clouds(self, c, img, y, pan, alpha=1.0, scale=1.0):
        p = skia.Paint(AntiAlias=True)
        p.setAlphaf(clamp(alpha))
        x = -(pan % 900)
        c.save()
        c.translate(x, y)
        c.scale(scale, scale)
        c.drawImage(img, 0, 0, skia.SamplingOptions(skia.FilterMode.kLinear), p)
        c.restore()

    def sun_flare(self, c, g, sx, sy, k, tint=(255, 220, 170)):
        """The sun, its bloom, a horizontal streak and the ghosts of the lens."""
        if k <= 0:
            return
        G = GLOW_SCALE
        radial(c, sx, sy, 420 * k, tint, 0.55 * k)
        radial(c, sx, sy, 90, PAPER, 0.95 * min(1, k * 1.4))
        radial(g, sx / G, sy / G, 90 * k + 20, tint, 0.9 * k)
        streak = skia.GradientShader.MakeLinear(points=[(sx - 900, 0), (sx + 900, 0)],
                                                colors=[color(tint, 0), color(PAPER, 0.4 * k), color(tint, 0)])
        p = skia.Paint(AntiAlias=True, Shader=streak)
        additive(p)
        c.drawRect(skia.Rect.MakeLTRB(sx - 900, sy - 3, sx + 900, sy + 3), p)
        dx, dy = CX - sx, CY - sy
        for f, r, rgb, a in ((0.6, 36, (140, 255, 200), 0.10), (1.15, 64, (255, 160, 220), 0.08),
                             (1.6, 22, (160, 200, 255), 0.14), (2.0, 110, (255, 220, 160), 0.06)):
            hx, hy = sx + dx * f, sy + dy * f
            hexa = poly([(hx + r * math.cos(i * math.pi / 3), hy + r * math.sin(i * math.pi / 3)) for i in range(6)])
            p = fill(rgb, a * k)
            additive(p)
            c.drawPath(hexa, p)

    def god_rays(self, c, ox, oy, k, angle=0.55, count=7, t=0.0, rgb=(255, 228, 170)):
        if k <= 0:
            return
        for i in range(count):
            a = angle + (i - count / 2) * 0.07 + 0.02 * math.sin(t * 0.3 + i)
            w = 0.018 + 0.012 * ((i * 37) % 5) / 5
            length = 2200
            pts = [(ox, oy), (ox + math.cos(a - w) * length, oy + math.sin(a - w) * length),
                   (ox + math.cos(a + w) * length, oy + math.sin(a + w) * length)]
            shader = skia.GradientShader.MakeRadial(center=(ox, oy), radius=length,
                                                    colors=[color(rgb, 0.2 * k), color(rgb, 0)])
            p = skia.Paint(AntiAlias=True, Shader=shader)
            additive(p)
            c.drawPath(poly(pts), p)

    def bokeh_layer(self, c, g, t, k, rgb_set, area=(0, 0, W, H), drift=(8, -4), size=1.0):
        if k <= 0:
            return
        x0, y0, x1, y1 = area
        for bx, by, s, ph, hue in self.bokeh:
            x = x0 + ((bx * (x1 - x0) + t * drift[0] * (0.5 + s)) % (x1 - x0))
            y = y0 + ((by * (y1 - y0) + t * drift[1] * (0.5 + s)) % (y1 - y0))
            r = (14 + 46 * s) * size
            rgb = rgb_set[int(hue * len(rgb_set)) % len(rgb_set)]
            a = k * (0.10 + 0.12 * math.sin(t * 0.8 + ph * 6) ** 2)
            p = fill(rgb, a)
            additive(p)
            c.drawCircle(x, y, r, p)
            c.drawCircle(x, y, r, additive(stroke(rgb, a * 0.8, 1.5)))

    def petals_layer(self, c, t, k, wind=1.0, count=420, area_y=(0, H), near=False):
        if k <= 0:
            return
        for i, (px, py, s, ph, spin, depth) in enumerate(self.petals[:count]):
            speed = (60 + 160 * depth) * wind
            x = (px * (W + 400) + t * speed) % (W + 400) - 200
            y = area_y[0] + ((py * (area_y[1] - area_y[0]) + t * (30 + 50 * depth)
                              + 40 * math.sin(t * (0.7 + s) + ph * 6)) % (area_y[1] - area_y[0]))
            size = 3 + 9 * depth ** 1.6 * (2.2 if near else 1)
            ang = t * (1 + 3 * spin) + ph * 6
            flip = abs(math.cos(t * (1.3 + spin) + ph * 5))
            c.save()
            c.translate(x, y)
            c.rotate(math.degrees(ang))
            c.scale(1, 0.35 + 0.65 * flip)
            rgb = mix((255, 196, 214), (255, 236, 240), s)
            c.drawOval(skia.Rect.MakeLTRB(-size, -size * 0.6, size, size * 0.6), fill(rgb, k * (0.6 + 0.4 * depth)))
            c.restore()

    def power_lines(self, c, t, x_pole, top, k, rgb=(22, 20, 34), sag=60, span=900, offset=0):
        if k <= 0:
            return
        for i in range(-1, 4):
            px = x_pole + i * span - (offset % span)
            c.drawRect(skia.Rect.MakeLTRB(px - 7, top - 10, px + 7, H), fill(rgb, k))
            c.drawRect(skia.Rect.MakeLTRB(px - 70, top + 10, px + 70, top + 18), fill(rgb, k))
            c.drawRect(skia.Rect.MakeLTRB(px - 50, top + 46, px + 50, top + 52), fill(rgb, k))
            for j, (dx, dy) in enumerate(((-64, 12), (-20, 12), (24, 12), (64, 12), (-44, 48), (44, 48))):
                p = skia.Path()
                p.moveTo(px + dx, top + dy)
                p.quadTo(px + dx + span / 2, top + dy + sag + j * 6, px + dx + span, top + dy)
                c.drawPath(p, stroke(rgb, k * 0.95, 2.2 if j < 4 else 1.6))

    def dial(self, c, g, t, a, radius, progress, rotation, needle=None, rgb=BRASS, needle_a=1.0, locked=0.0):
        if a <= 0:
            return
        G = GLOW_SCALE
        sweep = 360 * clamp(progress)
        rect = skia.Rect.MakeXYWH(CX - radius, CY - radius, radius * 2, radius * 2)
        c.drawArc(rect, -90 + rotation, sweep, False, stroke(rgb, 0.85 * a, 2.2))
        lit = int(120 * clamp(progress))
        major, minor = [], []
        for i in range(lit):
            ang = math.radians(-90 + rotation + i * 3)
            length = 26 if i % 10 == 0 else 11
            r0, r1 = radius + 6, radius + 6 + length
            seg = (skia.Point(CX + r0 * math.cos(ang), CY + r0 * math.sin(ang)),
                   skia.Point(CX + r1 * math.cos(ang), CY + r1 * math.sin(ang)))
            (major if i % 10 == 0 else minor).extend(seg)
        c.drawPoints(skia.Canvas.kLines_PointMode, major, stroke(rgb, 0.9 * a, 2.4))
        c.drawPoints(skia.Canvas.kLines_PointMode, minor, stroke(rgb, 0.55 * a, 1.3))
        c.drawCircle(CX, CY, radius * 0.86, stroke(rgb, 0.22 * a * clamp(progress * 2), 1))
        gp = additive(stroke(rgb, (0.45 + 0.4 * self.energy(t)) * a, 3))
        gp.setMaskFilter(self.blur[4])
        g.drawArc(skia.Rect.MakeXYWH((CX - radius) / G, (CY - radius) / G, 2 * radius / G, 2 * radius / G),
                  -90 + rotation, sweep, False, gp)
        if needle is not None and needle_a > 0:
            na = a * needle_a
            ang = math.radians(needle - 90)
            tip = (CX + (radius - 14) * math.cos(ang), CY + (radius - 14) * math.sin(ang))
            tail = (CX - 40 * math.cos(ang), CY - 40 * math.sin(ang))
            nc = mix(VERMILION, PAPER, locked * 0.4)
            c.drawLine(*tail, *tip, stroke(nc, 0.95 * na, 2.6))
            c.drawCircle(CX, CY, 5, fill(nc, na))
            gp = additive(stroke(nc, 0.8 * na, 5))
            gp.setMaskFilter(self.blur[4])
            g.drawLine(tail[0] / G, tail[1] / G, tip[0] / G, tip[1] / G, gp)

    def stars_layer(self, c, g, t, k, rot=0.0, centre=(CX, CY), clear_r=0.0, trails=0.0, horizon=H):
        """Stars wheeling about a pole; with trails > 0 they draw arcs like a long exposure."""
        if k <= 0:
            return
        ox, oy = centre
        bright, dim, arcs = [], [], []
        for sx, sy, s, ph in self.stars:
            r = 60 + (sx ** 0.7) * 1500
            th = sy * 2 * math.pi + rot * (0.6 + 0.0 * s)
            x, y = ox + r * math.cos(th), oy + r * math.sin(th) * 0.92
            if y > horizon or not (-40 < x < W + 40) or y < -40:
                continue
            fade = smooth((r - clear_r) / 120) if clear_r else 1.0
            if fade <= 0:
                continue
            tw = 0.6 + 0.4 * math.sin(t * (1 + 2 * s) + ph * 9)
            if trails > 0:
                arcs.append((r, th, s, fade))
            (bright if s > 0.85 else dim).append((skia.Point(x, y), tw * fade))
        if trails > 0:
            for r, th, s, fade in arcs:
                span = math.degrees(trails * (0.4 + 0.6 * s))
                rect = skia.Rect.MakeXYWH(ox - r, oy - r * 0.92, 2 * r, 2 * r * 0.92)
                rgb = mix((190, 210, 255), BRASS, s * 0.6)
                c.drawArc(rect, math.degrees(th) - span, span, False, stroke(rgb, k * 0.5 * fade * trails, 1.2))
        p = stroke(PAPER, k, 3.2)
        for pt, a in bright:
            p.setColor(color(PAPER, k * a))
            c.drawPoints(skia.Canvas.kPoints_PointMode, [pt], p)
        c.drawPoints(skia.Canvas.kPoints_PointMode, [pt for pt, _ in dim],
                     stroke((210, 220, 255), k * 0.55, 1.6))
        gp = additive(stroke(PAPER, k * 0.7, 2.5))
        gp.setMaskFilter(self.blur[1])
        g.drawPoints(skia.Canvas.kPoints_PointMode,
                     [skia.Point(pt.x() / GLOW_SCALE, pt.y() / GLOW_SCALE) for pt, _ in bright], gp)

    # -- I. the classroom window (0 - 21 s) -------------------------------
    def classroom(self, c, g, t):
        k_in = smooth((t - CUES["intro_in"]) / 2.6)
        push = ease_in_out((t - 12) / 9.5)            # dolly toward the window
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (255, 214, 160)), (0.55, (255, 186, 132)), (1, (255, 160, 120))])
        self.draw_clouds(c, self.clouds_gold, 40, t * 14, 1.0)
        sun = (1380 - t * 6, 300 + t * 2)
        self.sun_flare(c, g, sun[0], sun[1], 0.6 + 0.4 * e)
        # the room, framed around the window; scaled up as the camera pushes in
        c.save()
        sc = 1 + push * 1.9
        c.translate(1260, 420)
        c.scale(sc, sc)
        c.translate(-1260, -420)
        wall = skia.Path()
        wall.addRect(skia.Rect.MakeLTRB(-600, -400, W + 600, H + 400))
        win = skia.Rect.MakeLTRB(760, 120, 1780, 760)
        wall.addRect(win)
        wall.setFillType(skia.PathFillType.kEvenOdd)
        c.drawPath(wall, fill((70, 46, 52)))
        vgrad(c, -400, H + 400, [(0, (40, 26, 34)), (0.5, (96, 60, 58)), (1, (34, 22, 30))],
              rect=skia.Rect.MakeLTRB(-600, -400, 760, H + 400))
        mull = (34, 24, 30)
        for x in (760, 1100, 1440, 1780):
            c.drawRect(skia.Rect.MakeLTRB(x - 9, 120, x + 9, 760), fill(mull))
        for y in (120, 440, 760):
            c.drawRect(skia.Rect.MakeLTRB(760, y - 9, 1780, y + 9), fill(mull))
        c.drawRect(skia.Rect.MakeLTRB(720, 760, 1820, 800), fill((120, 80, 70)))   # sill, catching the light
        c.drawRect(skia.Rect.MakeLTRB(720, 760, 1820, 765), fill((255, 214, 170), 0.8))
        # sheer curtain lifting in the breeze
        wave = math.sin(t * 0.9) * 40 + 30 * self.energy(t)
        cur = skia.Path()
        cur.moveTo(1640, 110)
        cur.cubicTo(1700 - wave, 300, 1600 + wave, 520, 1680 - wave * 0.6, 790)
        cur.lineTo(1840, 790)
        cur.lineTo(1840, 110)
        cur.close()
        cp = fill((255, 244, 236), 0.55)
        c.drawPath(cur, cp)
        # desks in rows, long shadows
        for i, (dx, dy, dw) in enumerate(((60, 860, 520), (380, 930, 640), (-200, 1010, 700))):
            c.drawRect(skia.Rect.MakeLTRB(dx, dy, dx + dw, dy + 26), fill((150, 96, 70)))
            c.drawRect(skia.Rect.MakeLTRB(dx, dy, dx + dw, dy + 4), fill((255, 210, 160), 0.7))
            c.drawRect(skia.Rect.MakeLTRB(dx + 20, dy + 26, dx + 34, H + 200), fill((48, 30, 34)))
            c.drawRect(skia.Rect.MakeLTRB(dx + dw - 34, dy + 26, dx + dw - 20, H + 200), fill((48, 30, 34)))
        self.god_rays(c, 1300, 380, 0.9 + 0.5 * e, angle=2.45, count=8, t=t)
        # dust in the beams
        pts = []
        for mx, my, s, ph in self.motes:
            x = 300 + mx * 1300 + 30 * math.sin(t * 0.3 + ph * 7)
            y = 200 + ((my * 800 + t * (6 + 10 * s)) % 800)
            pts.append(skia.Point(x, y))
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts, additive(stroke((255, 236, 200), 0.5, 2.4)))
        # the student at her desk, turning to the window
        self.girl.wind = 0.5 + 0.5 * math.sin(t * 0.5)
        sit = Student.stand()
        turn = ease_in_out((t - 5) / 4)
        sit.update(bob=1.15, thigh_n=88, shin_n=-88, thigh_f=84, shin_f=-80, arm_n=-38, fore_n=-52,
                   arm_f=-44, fore_f=-46, head=lerp(14, -10, turn), torso=lerp(6, -2, turn))
        self.girl.side(c, 520, 1040, 64, sit, facing=1, light=(-1, -0.3), rim=(255, 220, 170), rim_a=0.9)
        c.restore()
        # the push resolves into white light, then the river
        white = smooth((t - 19.2) / 1.6)
        if white > 0:
            c.drawPaint(fill((255, 246, 230), white * 0.95))
        if k_in < 1:
            c.drawPaint(fill((0, 0, 0), 1 - k_in))

    # -- II. the river at dusk (21 - 41.5 s) ------------------------------
    def river(self, c, g, t):
        lt = t - CUES["verse1"]
        e = self.energy(t)
        hz = 620
        vgrad(c, 0, hz, [(0, (92, 98, 170)), (0.35, (224, 140, 140)), (0.75, (255, 186, 120)), (1, (255, 214, 150))])
        self.draw_clouds(c, self.clouds_dusk, 20, 300 + lt * 10, 1.0)
        sun = (1250 + lt * 2, 560 + lt * 1.2)
        self.sun_flare(c, g, sun[0], sun[1], 0.75 + 0.35 * e, tint=(255, 200, 140))
        c.drawImage(self.city_far, -100 - lt * 4, hz - 150)
        c.drawImage(self.city_dusk, -200 - lt * 7, hz - 200)
        # the river: the sky again, broken into moving bands
        vgrad(c, hz, H, [(0, (255, 196, 140)), (0.3, (190, 120, 130)), (1, (40, 36, 70))])
        for i in range(70):
            y = hz + 4 + (i ** 1.6) * 0.9
            if y > H:
                break
            w = 40 + i * 9
            x = sun[0] + 200 * math.sin(i * 1.7 + lt * (0.4 + i * 0.01)) - w / 2
            p = additive(fill((255, 230, 180), 0.5 * (1 - i / 70)))
            c.drawRect(skia.Rect.MakeXYWH(x, y, w, 2 + i * 0.05), p)
        # the embankment and the path she walks
        bank = poly([(-50, 880), (W + 50, 820), (W + 50, H + 10), (-50, H + 10)])
        c.drawPath(bank, fill((40, 34, 52)))
        c.drawRect(skia.Rect.MakeLTRB(-50, 860, W + 50, 868), fill((255, 190, 140), 0.35))
        # tall grass in silhouette, swaying
        grass = []
        for i in range(260):
            gx = (i * 7.4 + 13 * math.sin(i)) % (W + 40)
            gy = 900 - 30 * math.sin(i * 0.37)
            hgt = 40 + 50 * ((i * 53) % 7) / 7
            sway = 10 * math.sin(lt * 1.3 + i * 0.3)
            grass.extend((skia.Point(gx, gy + 60), skia.Point(gx + sway, gy - hgt + 60)))
        c.drawPoints(skia.Canvas.kLines_PointMode, grass, stroke((30, 26, 40), 1, 2.2))
        self.power_lines(c, t, 300, 150, 1.0, offset=lt * 30, sag=80, span=1100)
        # birds crossing the sky
        for bx, by, s in self.birds:
            x = (bx * W + lt * (60 + 40 * s)) % (W + 200) - 100
            y = 200 + by * 200 + 10 * math.sin(lt * 2 + s * 9)
            flap = math.sin(lt * (8 + 4 * s) + bx * 20) * 6
            c.drawPath(poly([(x - 10, y - flap), (x, y), (x + 10, y - flap)], close=False),
                       stroke((40, 30, 50), 0.9, 2))
        # the student walking the embankment, the sun behind her
        phase = lt * 5.2
        self.girl.wind = 0.8
        walk_x = 380 + lt * 30
        self.girl.side(c, walk_x, 904, 30, Student.walk(phase, 0.9), facing=1, light=(1, -0.2),
                       rim=(255, 214, 160), rim_a=1.0)
        # a walk-and-turn closer shot in the second half
        close = smooth((lt - 10.5) / 0.6) * (1 - smooth((lt - 19.6) / 0.8))
        if close > 0:
            layer(c, close)
            vgrad(c, 0, H, [(0, (120, 100, 170)), (0.5, (255, 170, 130)), (1, (255, 214, 150))])
            self.draw_clouds(c, self.clouds_dusk, -60, 600 + lt * 22, 1.0, 1.25)
            self.sun_flare(c, g, 1520, 640, 0.9 + 0.3 * e, tint=(255, 200, 140))
            c.drawPath(poly([(-50, 900), (W + 50, 930), (W + 50, H + 10), (-50, H + 10)]), fill((34, 28, 46)))
            self.girl.wind = 1.1
            pose = Student.walk(lt * 4.6, 0.7)
            turn = ease_in_out((lt - 15) / 2.5)
            pose["head"] = lerp(0, 14, turn)
            self.girl.side(c, 860, 1120, 118, pose, facing=1, light=(1, -0.3), rim=(255, 220, 170), rim_a=1.0)
            self.petals_layer(c, t, 0.0)
            c.restore()

    # -- III. cherry blossoms (41.5 - 61.5 s) -----------------------------
    def sakura(self, c, g, t):
        lt = t - CUES["spring"]
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (90, 160, 236)), (0.55, (170, 214, 250)), (1, (230, 240, 250))])
        self.draw_clouds(c, self.clouds_day, 60, 120 + lt * 12, 1.0)
        self.sun_flare(c, g, 380, 120, 0.7 + 0.3 * e, tint=(255, 250, 230))
        # far campus: a long building with windows catching the sky
        c.drawRect(skia.Rect.MakeLTRB(-20, 640, W + 20, 820), fill((214, 212, 222)))
        for i in range(30):
            c.drawRect(skia.Rect.MakeXYWH(40 + i * 64, 670, 40, 40), fill((150, 190, 230)))
            c.drawRect(skia.Rect.MakeXYWH(40 + i * 64, 740, 40, 40), fill((150, 190, 230)))
        # path
        c.drawPath(poly([(0, 820), (W, 820), (W, H), (0, H)]), fill((222, 206, 200)))
        c.drawPath(poly([(700, 820), (1220, 820), (1700, H), (220, H)]), fill((236, 222, 214)))
        # sakura canopies: clusters of soft pink blossoms over dark trunks
        for tx, sz in ((150, 1.2), (560, 0.9), (1340, 1.0), (1780, 1.3)):
            c.drawPath(poly([(tx - 18, H), (tx - 8, 600), (tx + 8, 600), (tx + 22, H)]), fill((70, 48, 52)))
            c.drawLine(tx, 650, tx + 160 * sz, 470, stroke((70, 48, 52), 1, 14))
            c.drawLine(tx, 640, tx - 150 * sz, 480, stroke((70, 48, 52), 1, 12))
            for j in range(46):
                ang = j * 2.4
                r = (60 + 230 * ((j * 37) % 11) / 11) * sz
                bx = tx + math.cos(ang) * r * 1.2
                by = 420 + math.sin(ang) * r * 0.55 + 6 * math.sin(lt * 1.2 + j)
                rad = (60 + 40 * ((j * 13) % 5) / 5) * sz
                rgb = mix((246, 176, 200), (255, 230, 238), ((j * 7) % 9) / 9)
                c.drawCircle(bx, by + rad * 0.12, rad, fill(mix(rgb, (200, 120, 160), 0.35), 0.9))
                c.drawCircle(bx, by, rad * 0.92, fill(rgb, 0.92))
                c.drawCircle(bx - rad * 0.2, by - rad * 0.28, rad * 0.5, fill((255, 236, 244), 0.22))
        self.bokeh_layer(c, g, t, 0.35, [(255, 210, 230), (255, 250, 240)], area=(0, 0, W, 700), size=0.7)
        # she runs in, slows, and reaches for a falling petal
        run_k = 1 - smooth((lt - 9) / 2.5)
        x = lerp(-120, 960, ease_out(lt / 11))
        pose = Student.blend(Student.walk(lt * 8, 1.0, run=0.8), Student.stand(), 1 - run_k)
        reach = smooth((lt - 11.5) / 2.0)
        pose["arm_n"] = lerp(pose["arm_n"], -150, reach)
        pose["fore_n"] = lerp(pose["fore_n"], -8, reach)
        pose["head"] = lerp(pose["head"], -24, reach)
        self.girl.wind = 1.2
        self.girl.side(c, x, 1010, 46, pose, facing=1, light=(-0.6, -1), rim=(255, 255, 255), rim_a=0.6)
        self.petals_layer(c, t, 1.0, wind=1.0 + 0.6 * e)
        self.petals_layer(c, t + 50, 0.85, wind=1.3, count=60, near=True)
        # a sudden gust to whiteout as the verse turns
        gust = smooth((lt - 18.3) / 1.6)
        if gust > 0:
            c.drawPaint(fill((255, 236, 242), gust * 0.9))

    # -- IV. the level crossing and the sky (61.5 - 81.6 s) ---------------
    def crossing(self, c, g, t):
        lt = t - CUES["nation"]
        e = self.energy(t)
        tilt = ease_in_out((lt - 11) / 8)            # tilt up from the crossing into the sky
        oy = tilt * 760
        c.save()
        c.translate(0, oy)
        vgrad(c, -900, 760, [(0, (60, 70, 150)), (0.35, (180, 110, 150)), (0.7, (255, 150, 110)), (1, (255, 200, 130))])
        self.draw_clouds(c, self.clouds_eve, -820, 200 + lt * 16, 1.0, 1.45)
        self.draw_clouds(c, self.clouds_eve, 120, 600 + lt * 9, 0.9)
        sun = (980, 640 - lt * 3)
        self.sun_flare(c, g, sun[0], sun[1], 0.7 + 0.6 * e + 0.6 * smooth((lt - 15) / 4), tint=(255, 190, 120))
        c.drawImage(self.city_dusk, -150, 560)
        c.drawRect(skia.Rect.MakeLTRB(0, 760, W, H + 20), fill((54, 40, 54)))
        # rails converging, catching the sky
        for x0, x1 in ((-400, 860), (300, 920), (1620, 1000), (2320, 1060)):
            c.drawLine(x0, H + 20, x1, 770, stroke((255, 190, 140), 0.85, 4))
        # the crossing signal and gate
        blink = (int(lt * 2.4) % 2) if lt < 10.5 else -1
        for sx in (380, 1540):
            c.drawRect(skia.Rect.MakeLTRB(sx - 8, 380, sx + 8, 860), fill((24, 20, 30)))
            c.drawPath(poly([(sx - 60, 400), (sx + 60, 460), (sx + 60, 480), (sx - 60, 420)]), fill((235, 230, 220)))
            for j, lx in enumerate((sx - 46, sx + 46)):
                on = blink == j
                c.drawCircle(lx, 520, 24, fill((60, 14, 18)))
                if on:
                    c.drawCircle(lx, 520, 20, fill((255, 70, 60)))
                    radial(g, lx / GLOW_SCALE, (520 + oy) / GLOW_SCALE, 30, (255, 60, 40), 0.9)
        gate = 1 - smooth((lt - 10.2) / 1.6)
        ang = math.radians(-80 * (1 - gate))
        for gx, side in ((420, 1), (1500, -1)):
            ex = gx + side * math.cos(ang) * 560
            ey = 700 + math.sin(ang) * 560 * side * side
            arm = capsule(gx, 700, ex, ey, 8, 6)
            c.drawPath(arm, fill((240, 236, 228)))
            for i in range(1, 7, 2):
                k0, k1 = i / 7, (i + 1) / 7
                c.drawLine(lerp(gx, ex, k0), lerp(700, ey, k0), lerp(gx, ex, k1), lerp(700, ey, k1),
                           stroke((210, 50, 50), 1, 14, skia.Paint.kButt_Cap))
        # she waits on the far side; the train hides her, then she is there
        self.girl.wind = 0.9
        self.girl.back(c, 980, 790, 30, light=(0, -1), rim=(255, 210, 150), rim_a=1.0, look_up=tilt)
        train_x = lerp(-3400, W + 600, smooth((lt - 1.5) / 8.5))
        if -3400 < train_x < W + 600:
            for car in range(5):
                x = train_x - car * 720
                if x + 700 < -50 or x > W + 50:
                    continue
                c.drawRect(skia.Rect.MakeXYWH(x, 520, 700, 300), fill((186, 192, 206)))
                c.drawRect(skia.Rect.MakeXYWH(x, 560, 700, 12), fill((40, 120, 110)))
                for wi in range(6):
                    c.drawRect(skia.Rect.MakeXYWH(x + 40 + wi * 110, 600, 80, 90), fill((255, 214, 160)))
                    c.drawRect(skia.Rect.MakeXYWH(x + 40 + wi * 110, 600, 80, 10), fill(PAPER, 0.8))
                c.drawRect(skia.Rect.MakeXYWH(x, 780, 700, 40), fill((70, 70, 84)))
                # motion blur ghosting
                ghost = fill((255, 220, 180), 0.08)
                additive(ghost)
                c.drawRect(skia.Rect.MakeXYWH(x - 120, 520, 900, 300), ghost)
        c.restore()
        # the sky takes over: "力量" as the light fills it
        whiteout = smooth((lt - 18.4) / 1.6) * (1 - smooth((lt - 20.4) / 0.4))
        if whiteout > 0:
            c.drawPaint(fill((255, 230, 200), whiteout * 0.8))

    # -- V. blue hour, power lines (81.6 - 92 s) --------------------------
    def blue_hour(self, c, g, t):
        lt = t - CUES["interlude"]
        vgrad(c, 0, H, [(0, (20, 28, 74)), (0.5, (98, 76, 150)), (0.85, (236, 140, 150)), (1, (255, 180, 140))])
        self.stars_layer(c, g, t, smooth(lt / 6) * 0.6, rot=lt * 0.002, horizon=700)
        self.draw_clouds(c, self.clouds_blue, 300, 200 + lt * 8, 0.9)
        # the moon, a thin crescent
        c.drawCircle(1500, 230, 46, fill((255, 246, 220)))
        c.drawCircle(1522, 220, 44, fill((40, 40, 96)))
        radial(g, 1500 / GLOW_SCALE, 230 / GLOW_SCALE, 40, (220, 220, 255), 0.5)
        c.drawImage(self.city_night_far, -100 - lt * 4, H - 220)
        self.power_lines(c, t, 200, 260, 1.0, rgb=(14, 14, 30), sag=110, span=1300, offset=lt * 18)
        # telegraph silhouettes nearer, slower
        c.drawRect(skia.Rect.MakeLTRB(0, H - 60, W, H), fill((10, 10, 24)))

    # -- VI. 细量: the careful measurement (92 - 112.5 s) -----------------
    def measure(self, c, g, t):
        lt = t - CUES["verse2"]
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (16, 22, 60)), (0.6, (60, 56, 120)), (1, (180, 110, 140))])
        self.stars_layer(c, g, t, 0.7, rot=t * 0.003, horizon=800)
        c.drawImage(self.city_night_far, -60, 640)
        c.drawImage(self.city_night, -200 - lt * 3, 700)
        self.bokeh_layer(c, g, t, 0.45, [(255, 200, 140), (180, 200, 255), (255, 160, 170)],
                         area=(0, 650, W, H), drift=(-6, 0), size=0.7)
        # rooftop
        c.drawRect(skia.Rect.MakeLTRB(0, 930, W, H), fill((26, 26, 48)))
        c.drawRect(skia.Rect.MakeLTRB(0, 930, W, 936), fill((200, 170, 200), 0.5))
        for x in range(0, W, 60):
            c.drawRect(skia.Rect.MakeLTRB(x, 860, x + 6, 930), fill((40, 40, 66)))
        c.drawRect(skia.Rect.MakeLTRB(0, 856, W, 866), fill((40, 40, 66)))
        # the instrument: a theodolite on its tripod
        ix, iy = 1180, 660
        for lx in (-130, 10, 150):
            c.drawLine(ix, iy + 40, ix + lx, 930, stroke((180, 160, 120), 1, 7))
        c.drawRect(skia.Rect.MakeXYWH(ix - 50, iy - 10, 100, 60), fill((60, 70, 90)))
        c.drawRect(skia.Rect.MakeXYWH(ix - 50, iy - 10, 100, 8), fill((200, 210, 230), 0.6))
        c.drawCircle(ix, iy + 22, 18, fill(BRASS))
        tube = capsule(ix - 90, iy - 40, ix + 80, iy - 62, 18, 14)
        c.drawPath(tube, fill((70, 82, 104)))
        c.drawPath(capsule(ix - 90, iy - 40, ix + 80, iy - 62, 18, 14), stroke((220, 230, 250), 0.4, 2))
        radial(g, (ix + 82) / GLOW_SCALE, (iy - 62) / GLOW_SCALE, 10, (220, 240, 255), 0.6)
        # she kneels at the eyepiece, adjusting the fine knob
        self.girl.wind = 0.4
        kneel = Student.stand()
        adjust = math.sin(lt * 1.6) * 4
        kneel.update(bob=2.55, thigh_n=58, shin_n=-150, thigh_f=50, shin_f=-142, torso=24,
                     arm_n=-70 + adjust, fore_n=-50, arm_f=-80, fore_f=-40, head=10)
        self.girl.side(c, 1005, 930, 34, kneel, facing=1, light=(-1, -0.5), rim=(230, 200, 255), rim_a=0.8)
        # insert: the vernier coming into agreement, macro, with the city melted behind
        ins = smooth((lt - 6.5) / 0.7) * (1 - smooth((lt - 13.5) / 0.7))
        if ins > 0:
            layer(c, ins)
            vgrad(c, 0, H, [(0, (12, 16, 44)), (1, (40, 30, 70))])
            self.bokeh_layer(c, g, t, 0.6, [(255, 200, 140), (180, 200, 255), (255, 150, 170)], size=2.2)
            slide = 1 - ease_out((lt - 7) / 5.5)
            base_y, step = 520, 40
            top = poly([(0, base_y - 160), (W, base_y - 160), (W, base_y), (0, base_y)])
            c.drawPath(top, fill((196, 160, 96)))
            c.drawRect(skia.Rect.MakeLTRB(0, base_y - 4, W, base_y), fill(PAPER, 0.7))
            ticks = []
            for i in range(-2, W // step + 3):
                x = i * step
                L = 70 if i % 10 == 0 else 46 if i % 5 == 0 else 28
                ticks.extend((skia.Point(x, base_y), skia.Point(x, base_y - L)))
            c.drawPoints(skia.Canvas.kLines_PointMode, ticks, stroke((40, 30, 24), 1, 3, skia.Paint.kButt_Cap))
            off = 120 * slide + 6 * math.sin(lt * 9) * slide
            bot = poly([(0, base_y + 8), (W, base_y + 8), (W, base_y + 160), (0, base_y + 160)])
            c.drawPath(bot, fill((168, 176, 190)))
            vt = []
            for i in range(-2, W // 36 + 3):
                x = CX + (i - W // 72) * 36 + off
                L = 60 if i % 10 == 0 else 34
                vt.extend((skia.Point(x, base_y + 8), skia.Point(x, base_y + 8 + L)))
            c.drawPoints(skia.Canvas.kLines_PointMode, vt, stroke((24, 28, 40), 1, 3, skia.Paint.kButt_Cap))
            agree = smooth((lt - 11.8) / 0.5) * (1 - smooth((lt - 13.2) / 0.4))
            if agree > 0:
                radial(c, CX, base_y + 4, 160, (255, 236, 200), 0.6 * agree)
                radial(g, CX / GLOW_SCALE, (base_y + 4) / GLOW_SCALE, 30, PAPER, agree)
            c.restore()
        # a second insert: her eye at the eyepiece, a star held in the crosshair
        eye = smooth((lt - 15.3) / 0.6) * (1 - smooth((lt - 19.8) / 0.6))
        if eye > 0:
            layer(c, eye)
            c.drawPaint(fill((4, 6, 16)))
            r = 380
            c.save()
            clip = skia.Path()
            clip.addCircle(CX, CY, r)
            c.clipPath(clip, skia.ClipOp.kIntersect, True)
            vgrad(c, CY - r, CY + r, [(0, (14, 20, 60)), (1, (40, 40, 90))])
            self.stars_layer(c, g, t, 1.0, rot=(t - 105) * 0.01)
            c.drawLine(CX - r, CY, CX + r, CY, stroke(PAPER, 0.6, 1.2))
            c.drawLine(CX, CY - r, CX, CY + r, stroke(PAPER, 0.6, 1.2))
            for i in range(-9, 10):
                c.drawLine(CX + i * 36, CY - 8, CX + i * 36, CY + 8, stroke(PAPER, 0.45, 1))
            settle = ease_out((lt - 15.8) / 3)
            sx, sy = CX + 140 * (1 - settle), CY - 90 * (1 - settle)
            c.drawCircle(sx, sy, 4, fill(PAPER))
            radial(g, sx / GLOW_SCALE, sy / GLOW_SCALE, 14, (220, 230, 255), 0.9)
            c.restore()
            c.drawCircle(CX, CY, r, stroke((60, 70, 100), 1, 18))
            c.restore()

    # -- VII. 精思国计: over the city, under the stars (112.5 - 141 s) ----
    def overlook(self, c, g, t):
        lt = t - CUES["lattice"]
        e = self.energy(t)
        rise = ease_in_out((lt - 18) / 10)           # camera rises toward the sky
        oy = rise * 520
        c.save()
        c.translate(0, oy)
        vgrad(c, -700, 900, [(0, (4, 6, 22)), (0.6, (14, 22, 62)), (1, (60, 50, 110))])
        c.drawImage(self.milky, 0, -500, skia.SamplingOptions(skia.FilterMode.kLinear))
        self.stars_layer(c, g, t, 1.0, rot=t * 0.003, horizon=760, centre=(CX, CY - 200))
        # shooting stars on the strong beats
        for k, t0 in enumerate((119.4, 127.2, 133.6)):
            u = (t - t0) / 0.9
            if 0 < u < 1:
                sx = 300 + k * 520 + u * 360
                sy = -40 + k * 30 + u * 180
                sh = skia.GradientShader.MakeLinear(points=[(sx - 220, sy - 110), (sx, sy)],
                                                    colors=[color(PAPER, 0), color(PAPER, 0.9 * (1 - u))])
                p = skia.Paint(AntiAlias=True, Shader=sh, Style=skia.Paint.kStroke_Style, StrokeWidth=2.4)
                c.drawLine(sx - 220, sy - 110, sx, sy, p)
                radial(g, sx / GLOW_SCALE, (sy + oy) / GLOW_SCALE, 10, PAPER, 1 - u)
        # the city below, laid out to the horizon; streets come into grid as she thinks
        c.drawImage(self.city_night_far, -100, 600)
        grid_k = smooth((lt - 9) / 8)
        horizon = 780
        for i in range(1, 24):
            y = horizon + (i / 24) ** 1.8 * 320
            p = additive(stroke((255, 200, 140), 0.12 + 0.35 * grid_k * (0.6 + 0.4 * e), 1.4))
            c.drawLine(-20, y, W + 20, y, p)
        for i in range(-30, 31):
            p = additive(stroke((255, 200, 140), 0.08 + 0.3 * grid_k, 1.2))
            c.drawLine(CX + i * 6, horizon, CX + i * 130, H + 200, p)
        dots = []
        for i in range(900):
            u, v = ((i * 0.6180339) % 1), ((i * 0.7548776) % 1)
            y = horizon + v ** 1.8 * 320
            x = CX + (u - 0.5) * (200 + 3600 * v ** 1.8)
            dots.append(skia.Point(x, y))
        c.drawPoints(skia.Canvas.kPoints_PointMode, dots, additive(stroke((255, 214, 160), 0.7, 2.4)))
        radial(c, CX, horizon + 10, 700, (255, 170, 120), 0.18)
        # the hill she sits on
        hill = skia.Path()
        hill.moveTo(-50, 900)
        hill.quadTo(500, 840, 900, 960)
        hill.lineTo(900, H + 600)
        hill.lineTo(-50, H + 600)
        hill.close()
        c.drawPath(hill, fill((8, 10, 24)))
        self.girl.wind = 0.6
        self.girl.back(c, 430, 885, 38, sit=True, arm_up=smooth((lt - 13) / 3) * (1 - smooth((lt - 24) / 3)),
                       look_up=smooth((lt - 6) / 4), light=(0.4, 1), rim=(255, 200, 150), rim_a=0.7)
        c.restore()

    # -- VIII. the sky turns into a scale (141 - 158.1 s) -----------------
    def heavens(self, c, g, t):
        lt = t - CUES["converge"]
        span = CUES["ji"] - CUES["converge"]
        k = clamp(lt / span)
        vgrad(c, 0, H, [(0, (4, 6, 20)), (0.7, (10, 16, 48)), (1, (30, 30, 70))])
        p = skia.Paint()
        p.setAlphaf(1 - 0.6 * k)
        c.drawImage(self.milky, 0, -500 + 520 * (1 - k), skia.SamplingOptions(skia.FilterMode.kLinear), p)
        # long-exposure star trails tightening into concentric graduations
        self.stars_layer(c, g, t, 1.0, rot=t * 0.003 + k * 0.6, clear_r=320 * smooth(k * 1.3), trails=1.6 * ease_in_out(k))
        rebuild = ease_out((lt - 6) / (span - 6))
        self.dial(c, g, t, smooth((lt - 5) / 3), 300, rebuild, -90 * (1 - rebuild))
        dawn = smooth((lt - 10) / 7)
        radial(c, CX, H + 80, 900, (255, 160, 110), 0.25 * dawn)

    # -- IX. 计量 (158.1 s - D) -------------------------------------------
    def standard(self, c, g, t):
        cu = CUES
        ji_k = clamp((t - cu["ji"]) / (cu["liang"] - cu["ji"]))
        liang_k = ease_out((t - cu["liang"]) / (cu["sung_end"] - cu["liang"]))
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (4, 6, 20)), (0.65, (12, 18, 52)), (1, mix((30, 30, 70), (120, 70, 90), liang_k))])
        self.stars_layer(c, g, t, 1.0, rot=t * 0.003 + 0.6, clear_r=320 + 120 * liang_k,
                         trails=1.6 * (1 - 0.7 * liang_k))
        # the dawn coming up behind the far city
        radial(c, CX, H + 120, 1100, (255, 160, 110), 0.25 + 0.3 * liang_k)
        c.drawImage(self.city_night_far, -100, H - 140)
        needle = -150 * (1 - smooth(ji_k)) + 6 * math.sin(ji_k * 14) * (1 - ji_k)
        locked = smooth((t - cu["liang"] + 0.3) / 0.6)
        self.dial(c, g, t, 1 - 0.45 * liang_k, 300 + 240 * liang_k, 1.0, 0, needle,
                  needle_a=1 - smooth((t - cu["liang"] - 0.8) / 2.6), locked=locked)
        if t >= cu["liang"] - 0.2:
            flash = math.exp(-max(0.0, t - cu["liang"]) / 0.9) * smooth((t - cu["liang"] + 0.2) / 0.25)
            radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 220, PAPER, 0.5 * flash)
            for n in range(4):
                rk = ease_out((t - cu["liang"] - n * 0.45) / 4.5)
                if 0 < rk < 1:
                    c.drawCircle(CX, CY, 300 + rk * 900, stroke(PAPER if n % 2 else BRASS, (1 - rk) * 0.6, 1.6))
        # the quiet stage the CSS carries on: survey grid, centre glow
        a = smooth((t - cu["liang"] + 0.5) / 3.0)
        grid = []
        for x in range(0, W + 1, 96):
            grid.extend((skia.Point(x, 0), skia.Point(x, H)))
        for y in range(-12, H + 1, 96):
            grid.extend((skia.Point(0, y), skia.Point(W, y)))
        c.drawPoints(skia.Canvas.kLines_PointMode, grid, stroke(BRASS, a * 0.08, 1, skia.Paint.kButt_Cap))
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 150 + 30 * liang_k, BRASS, a * 0.3)
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 60, VERMILION, a * 0.15)
        # she is still there, small, on the hill at the edge of the frame, looking up
        hill = skia.Path()
        hill.moveTo(-50, H - 40)
        hill.quadTo(260, H - 110, 560, H + 10)
        hill.lineTo(-50, H + 10)
        hill.close()
        c.drawPath(hill, fill((6, 8, 20)))
        self.girl.wind = 0.5
        self.girl.back(c, 250, H - 88, 15, sit=True, look_up=1.0, light=(0.3, 1), rim=(255, 190, 150), rim_a=0.6)
        del e

    # -- frame ------------------------------------------------------------
    SCENES = None

    def frame(self, t):
        cu = CUES
        scenes = [
            (0.0, cu["verse1"], self.classroom),
            (cu["verse1"], cu["spring"], self.river),
            (cu["spring"], cu["nation"], self.sakura),
            (cu["nation"], cu["interlude"], self.crossing),
            (cu["interlude"], cu["verse2"], self.blue_hour),
            (cu["verse2"], cu["lattice"], self.measure),
            (cu["lattice"], cu["converge"], self.overlook),
            (cu["converge"], cu["ji"], self.heavens),
            (cu["ji"], self.duration + 1, self.standard),
        ]
        fade = 1.2
        c = self.surface.getCanvas()
        g = self.glow.getCanvas()
        g.clear(skia.ColorTRANSPARENT)
        c.clear(color(NIGHT))
        self.girl.t = t
        for i, (a, b, fn) in enumerate(scenes):
            if not (a - (fade if i else 0) <= t < b):
                continue
            alpha = 1.0 if i == 0 else smooth((t - (a - fade)) / fade)
            layer(c, alpha)
            layer(g, alpha)
            fn(c, g, t)
            g.restore()
            c.restore()
        # soft vignette, film-like
        vig = skia.GradientShader.MakeRadial(center=(CX, CY), radius=W * 0.66,
                                             colors=[color(NIGHT, 0), color(NIGHT, 0), color(NIGHT, 0.5)],
                                             positions=[0, 0.6, 1])
        c.drawPaint(skia.Paint(Shader=vig))
        # bloom: the glow layer blurred and added back
        glow_img = self.glow.makeImageSnapshot()
        gp = skia.Paint()
        gp.setBlendMode(skia.BlendMode.kPlus)
        gp.setImageFilter(skia.ImageFilters.Blur(6, 6))
        c.save()
        c.scale(GLOW_SCALE, GLOW_SCALE)
        c.drawImage(glow_img, 0, 0, skia.SamplingOptions(skia.FilterMode.kLinear), gp)
        c.restore()
        if t < cu["intro_in"]:
            c.drawPaint(fill((0, 0, 0)))
        return self.surface.makeImageSnapshot().tobytes()


# ---------------------------------------------------------------- render
def render_range(args):
    audio, duration, start, end, out = args
    film = Film(loudness_envelope(audio, duration), duration)
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "12",
         "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i in range(start, end):
        enc.stdin.write(film.frame(i / FPS))
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed for {out}")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--preview", type=float, nargs="*", help="write PNG stills at these times and exit")
    ap.add_argument("--webm-kbps", type=int, default=330)
    ap.add_argument("--mp4-kbps", type=int, default=300)
    opts = ap.parse_args()

    duration = media_duration(opts.audio)
    frames = int(round(duration * FPS))
    os.makedirs(opts.out_dir, exist_ok=True)

    if opts.preview:
        film = Film(loudness_envelope(opts.audio, duration), duration)
        for t in opts.preview:
            img = skia.Image.frombytes(film.frame(t), skia.ISize(W, H), skia.kBGRA_8888_ColorType)
            img.save(os.path.join(opts.out_dir, f"still_{t:07.2f}.png"))
        return

    with tempfile.TemporaryDirectory() as tmp:
        bounds = np.linspace(0, frames, opts.workers + 1).astype(int)
        jobs = [(opts.audio, duration, int(a), int(b), os.path.join(tmp, f"part{i:02d}.mp4"))
                for i, (a, b) in enumerate(zip(bounds[:-1], bounds[1:]))]
        with ProcessPoolExecutor(opts.workers) as pool:
            parts = list(pool.map(render_range, jobs))
        listing = os.path.join(tmp, "parts.txt")
        with open(listing, "w") as fh:
            fh.writelines(f"file '{p}'\n" for p in parts)
        master = os.path.join(tmp, "master.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing,
                        "-c", "copy", master], check=True)

        webm = os.path.join(opts.out_dir, "easteregg.webm")
        mp4 = os.path.join(opts.out_dir, "easteregg.mp4")
        vp9 = ["-c:v", "libvpx-vp9", "-b:v", f"{opts.webm_kbps}k", "-maxrate", f"{int(opts.webm_kbps * 1.6)}k",
               "-bufsize", f"{opts.webm_kbps * 4}k", "-row-mt", "1", "-tile-columns", "2", "-g", "150",
               "-deadline", "good", "-cpu-used", "2", "-an", "-pix_fmt", "yuv420p"]
        passlog = os.path.join(tmp, "vp9")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", master, *vp9, "-pass", "1",
                        "-passlogfile", passlog, "-f", "null", "-"], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", master, *vp9, "-pass", "2",
                        "-passlogfile", passlog, webm], check=True)
        x264 = ["-c:v", "libx264", "-preset", "slow", "-b:v", f"{opts.mp4_kbps}k",
                "-maxrate", f"{int(opts.mp4_kbps * 1.6)}k", "-bufsize", f"{opts.mp4_kbps * 4}k",
                "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"]
        passlog = os.path.join(tmp, "x264")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", master, *x264, "-pass", "1",
                        "-passlogfile", passlog, "-f", "null", "-"], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", master, *x264, "-pass", "2",
                        "-passlogfile", passlog, mp4], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.1", "-i", master, "-frames:v", "1",
                        "-q:v", "3", os.path.join(opts.out_dir, "easteregg-final.jpg")], check=True)
    print(json.dumps({"duration": duration, "frames": frames, "fps": FPS, "cues": CUES}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
