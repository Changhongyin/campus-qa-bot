#!/usr/bin/env python3
"""Render the "Liangda Zhida" easter-egg film against the anthem.

A campus anime short in the visual language of Makoto Shinkai's films, painted
in code: the places are the protagonist (a dawn classroom and its corridor, a
stairwell, the river embankment, a level crossing under power lines, a rooftop
beneath a cumulonimbus, a sea of clouds, a rain-soaked street with a
convenience store, a stone stairway with lanterns, the city at night), lit by
golden-hour sun, god rays, flares and bloom, and graded teal into orange. One
university student moves through them, small against the vista, with close-ups
of her eye, her steps and her hands.

The motto 精思国计，细量民生 is told without words. 细量: her hands settle a
spirit level, a vernier slides into agreement, her eye holds the scale. 精思国计:
the river, the city and the night sky open before her, the streets resolve into
a survey grid, she reads a star chart, and the star trails become the graduated
circle of the final "计量".

There is no text in the film. Every shot boundary is a measured time in the
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

# Character palette (cel base, cel shade): a university student, jacket and long skirt.
SKIN = ((250, 222, 200), (214, 160, 140))
HAIR = ((58, 40, 44), (30, 20, 30))
SHIRT = ((246, 244, 240), (178, 182, 206))
JACKET = ((86, 112, 156), (50, 66, 106))
SKIRT = ((56, 58, 80), (30, 32, 50))
SHOES = ((236, 234, 230), (170, 172, 186))
STRAP = (150, 110, 80)
UMBRELLA = ((226, 236, 244), (160, 178, 200))
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


def cel(c, path, tone, light, rim=None, rim_a=0.0, rim_w=0.09):
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
        p = stroke(rim, rim_a, rim_w)  # in head units: a fine line of light
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



# ---------------------------------------------------------------- more textures
def make_tower(w, h, seed, lit, shade, rim, sun_dir=(1.0, -0.6)):
    """A cumulonimbus: a towering column on a broad base, flattening into an anvil."""
    mass = noise(w, h, seed, octaves=3, cell=360, persistence=0.5)
    detail = noise(w, h, seed + 1, octaves=5, cell=150, persistence=0.52)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    v = yy / h                                            # 0 top .. 1 base
    width = 0.16 + 0.22 * v ** 1.4 + 0.3 * np.exp(-((v - 0.08) / 0.07) ** 2)   # anvil near the top
    u = (xx / w - 0.5) / width
    d = mass * 0.6 + detail * 0.55 + 0.75 - u * u * 0.9
    d *= np.clip((0.97 - v) / 0.05, 0, 1) * np.clip(v / 0.03, 0, 1)
    alpha = np.clip((d - 0.72) / 0.07, 0, 1)
    soft = np.asarray(Image.fromarray(np.clip(d * 160, 0, 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(16)), np.float32) / 160
    sx, sy = sun_dir
    norm = math.hypot(sx, sy) or 1
    oy, ox = int(round(sy / norm * 40)), int(round(sx / norm * 40))
    pad = np.pad(soft, ((abs(oy), abs(oy)), (abs(ox), abs(ox))), mode="edge")
    toward = pad[abs(oy) + oy: abs(oy) + oy + h, abs(ox) + ox: abs(ox) + ox + w]
    light = np.clip((soft - toward) * 6 + 0.35 + 0.35 * (1 - v), 0, 1)
    light = light * light * (3 - 2 * light)
    edge = np.clip(alpha * (1 - alpha) * 4, 0, 1) * np.clip(light * 1.6, 0, 1)
    lit, shade, rim = (np.array(x, np.float32) for x in (lit, shade, rim))
    rgb = shade + (lit - shade) * light[..., None]
    rgb = rgb + (rim - rgb) * (edge[..., None] * 0.95)
    return to_image(rgb, alpha)


def make_cloud_sea(w, h, seed, lit, shade, rim):
    """A sea of cloud seen from above: rolling tops lit from the sky, valleys in shade."""
    mass = noise(w, h, seed, octaves=3, cell=300, persistence=0.5)
    detail = noise(w, h, seed + 1, octaves=5, cell=110, persistence=0.55)
    d = mass * 0.8 + detail * 0.5
    ys = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    alpha = np.clip((d - 0.5 + 0.25 * ys) / 0.08, 0, 1)
    soft = np.asarray(Image.fromarray(np.clip(d * 200, 0, 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(10)), np.float32) / 200
    up = np.pad(soft, ((16, 0), (0, 0)), mode="edge")[:h]
    light = np.clip((soft - up) * 9 + 0.5, 0, 1)
    light = light * light * (3 - 2 * light)
    edge = np.clip(alpha * (1 - alpha) * 4, 0, 1) * light
    lit, shade, rim = (np.array(x, np.float32) for x in (lit, shade, rim))
    rgb = shade + (lit - shade) * light[..., None]
    rgb = rgb + (rim - rgb) * (edge[..., None] * 0.8)
    return to_image(rgb, alpha)


def grade(frame_bgra, amount=1.0):
    """Cinematic split tone: teal into the shadows, warm orange into the highlights."""
    a = np.frombuffer(frame_bgra, np.uint8).reshape(H, W, 4).astype(np.float32)
    luma = (a[..., 2] * 0.3 + a[..., 1] * 0.59 + a[..., 0] * 0.11) / 255
    sh = ((1 - luma) ** 2 * 0.10 * amount)[..., None]
    hi = (luma ** 2 * 0.07 * amount)[..., None]
    teal = np.array([150, 120, 20], np.float32)       # BGR
    orange = np.array([40, 150, 255], np.float32)
    a[..., :3] = a[..., :3] * (1 - sh - hi) + teal * sh + orange * hi
    a[..., :3] = (a[..., :3] - 128) * 1.06 + 128       # a little contrast
    return np.clip(a, 0, 255).astype(np.uint8).tobytes()


class Persp:
    """One-point perspective: x right, y down, z into the picture."""

    def __init__(self, vx, vy, f):
        self.vx, self.vy, self.f = vx, vy, f

    def p(self, x, y, z):
        return (self.vx + x * self.f / z, self.vy + y * self.f / z)

    def quad(self, *pts):
        return poly([self.p(*q) for q in pts])


# ---------------------------------------------------------------- the student
LINE = (60, 40, 52)


class Student:
    """A cel-shaded university student, posed from joint angles. Units: one head = 1."""

    def __init__(self):
        self.wind = 0.0
        self.t = 0.0
        self.line = True
        self.px = 30.0     # pixels per head of the current drawing, so lines stay fine at any size

    def cel(self, c, path, tone, L, rim=None, rim_a=0.0):
        cel(c, path, tone, L, rim, rim_a, rim_w=min(0.09, 4.0 / self.px))
        if self.line:
            c.drawPath(path, stroke(LINE, 0.85, min(0.035, 1.8 / self.px)))

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
            arm_n=-20 * s * stride * k, arm_f=20 * s * stride * k,
            fore_n=16 + 30 * run, fore_f=16 + 30 * run,
            bob=abs(math.cos(phase)) * 0.09 * stride * k, skirt=6 * s * stride)
        return p

    @staticmethod
    def blend(a, b, k):
        return {key: lerp(a[key], b[key], k) for key in a}

    # -- side view --------------------------------------------------------
    def side(self, c, x, y, s, pose, facing=1, light=(-1, -0.4), rim=None, rim_a=0.0, blink=0.0):
        """(x, y) is the ground point under the hips; s pixels per head."""
        self.px = s
        c.save()
        c.translate(x, y)
        c.scale(facing * s, s)
        L = (light[0] * facing * 0.09, light[1] * 0.09)
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
            skin = SKIN if near else (SKIN[1], SKIN[1])
            self.cel(c, capsule(hip[0], hip[1], knee[0], knee[1], 0.3, 0.2), skin, L)
            self.cel(c, capsule(knee[0], knee[1], ankle[0], ankle[1], 0.21, 0.14), skin, L)
            fa = A(th + sh)
            toe = (ankle[0] + math.cos(fa) * 0.5, ankle[1] - math.sin(fa) * 0.1 + 0.05)
            self.cel(c, capsule(ankle[0] - 0.05, ankle[1] + 0.02, toe[0], toe[1], 0.17, 0.14), SHOES, L)

        def arm(a1, a2, near):
            sh = (neck[0] + math.sin(tor) * -0.3, neck[1] + 0.35)
            elbow, wrist = limb(sh, -a1, -a2, 1.25, 1.15)
            sleeve = JACKET if near else (JACKET[1], JACKET[1])
            self.cel(c, capsule(sh[0], sh[1], elbow[0], elbow[1], 0.25, 0.2), sleeve, L, rim, rim_a)
            self.cel(c, capsule(elbow[0], elbow[1], wrist[0], wrist[1], 0.2, 0.17), sleeve, L, rim, rim_a)
            self.cel(c, capsule(wrist[0], wrist[1], wrist[0] + math.sin(A(-a1 - a2)) * 0.32,
                                wrist[1] + math.cos(A(-a1 - a2)) * 0.32, 0.12, 0.1), SKIN, L)

        arm(pose["arm_f"], pose["fore_f"], False)
        leg(pose["thigh_f"], pose["shin_f"], False)
        sk = A(pose["skirt"] + self.wind * 7 * math.sin(self.t * 2.3))
        skirt = poly([(hip[0] - 0.55, hip[1] - 0.35), (hip[0] + 0.55, hip[1] - 0.35),
                      (hip[0] + 1.05 + math.sin(sk) * 0.7, hip[1] + 2.3),
                      (hip[0] - 0.95 + math.sin(sk) * 0.7 - self.wind * 0.3, hip[1] + 2.35)])
        leg(pose["thigh_n"], pose["shin_n"], True)
        self.cel(c, skirt, SKIRT, L, rim, rim_a)
        body = skia.Path()
        bx, by = hip
        nx, ny = neck
        body.moveTo(bx - 0.66, by + 0.1)
        body.cubicTo(bx - 0.78, by - 1.2, nx - 0.8, ny + 0.9, nx - 0.5, ny + 0.15)
        body.lineTo(nx + 0.42, ny + 0.15)
        body.cubicTo(nx + 0.78, ny + 0.9, bx + 0.74, by - 1.0, bx + 0.66, by + 0.1)
        body.close()
        self.cel(c, body, JACKET, L, rim, rim_a)
        self.cel(c, poly([(nx - 0.02, ny + 0.12), (nx + 0.44, ny + 0.16), (nx + 0.34, ny + 1.1),
                          (nx + 0.12, ny + 0.9)]), SHIRT, L)
        # a strap of the tote bag across the shoulder
        c.drawLine(nx - 0.1, ny + 0.2, bx - 0.5, by - 0.1, stroke(STRAP, 1, 0.12))
        arm(pose["arm_n"], pose["fore_n"], True)
        self.head_side(c, nx, ny, pose["neck"] + pose["torso"] * 0.5 + pose["head"], L, rim, rim_a, blink)
        c.restore()

    def head_side(self, c, nx, ny, tilt, L, rim, rim_a, blink=0.0):
        c.save()
        c.translate(nx, ny)
        c.rotate(tilt)
        self.cel(c, capsule(0, 0.1, 0.05, -0.3, 0.16, 0.16), SKIN, L)
        hx, hy = 0.12, -0.74
        # long locks behind the head first
        for i in range(5):
            sway = self.wind * (0.12 + 0.04 * i) * math.sin(self.t * (1.5 + 0.23 * i) + i * 1.3)
            rx, ry = hx - 0.5 + i * 0.07, hy - 0.45 + i * 0.16
            tip = (rx - 0.18 - self.wind * (0.35 + 0.08 * i) + sway, hy + 1.25 - abs(i - 2) * 0.08)
            lock = skia.Path()
            lock.moveTo(rx + 0.22, ry)
            lock.cubicTo(rx + 0.15, ry + 0.6, tip[0] + 0.25, tip[1] - 0.4, *tip)
            lock.cubicTo(tip[0] - 0.05, tip[1] - 0.5, rx - 0.22, ry + 0.5, rx - 0.12, ry)
            lock.close()
            self.cel(c, lock, HAIR, L, rim, rim_a)
        face = skia.Path()
        face.moveTo(hx - 0.5, hy - 0.2)
        face.cubicTo(hx - 0.5, hy - 0.75, hx + 0.5, hy - 0.8, hx + 0.52, hy - 0.15)
        face.lineTo(hx + 0.57, hy + 0.06)
        face.lineTo(hx + 0.51, hy + 0.2)
        face.cubicTo(hx + 0.5, hy + 0.42, hx + 0.27, hy + 0.6, hx + 0.03, hy + 0.6)
        face.cubicTo(hx - 0.35, hy + 0.55, hx - 0.5, hy + 0.3, hx - 0.5, hy - 0.2)
        face.close()
        self.cel(c, face, SKIN, L)
        crown = skia.Path()
        crown.moveTo(hx + 0.55, hy - 0.2)
        crown.cubicTo(hx + 0.62, hy - 1.05, hx - 0.78, hy - 1.05, hx - 0.64, hy - 0.05)
        crown.cubicTo(hx - 0.62, hy + 0.35, hx - 0.45, hy + 0.6, hx - 0.3, hy + 0.7)
        crown.lineTo(hx - 0.02, hy + 0.15)
        crown.cubicTo(hx + 0.12, hy - 0.3, hx + 0.35, hy - 0.4, hx + 0.55, hy - 0.2)
        crown.close()
        self.cel(c, crown, HAIR, L, rim, rim_a)
        # the specular ring of light across the hair
        ring = skia.Path()
        ring.addArc(skia.Rect.MakeLTRB(hx - 0.5, hy - 0.72, hx + 0.46, hy + 0.1), 200, 110)
        c.drawPath(ring, stroke((150, 120, 140), 0.8, 0.07))
        bang = skia.Path()
        bang.moveTo(hx + 0.55, hy - 0.25)
        bang.quadTo(hx + 0.62 + self.wind * 0.04 * math.sin(self.t * 3), hy - 0.02, hx + 0.48, hy + 0.12)
        bang.quadTo(hx + 0.42, hy - 0.2, hx + 0.2, hy - 0.4)
        bang.close()
        self.cel(c, bang, HAIR, L, rim, rim_a)
        c.drawLine(hx + 0.42, hy + 0.36, hx + 0.48, hy + 0.36, stroke(LINE, 0.7, 0.03))   # the mouth
        ex, ey = hx + 0.32, hy - 0.02
        open_k = 1 - clamp(blink)
        if open_k > 0.05:
            c.save()
            c.translate(ex, ey)
            c.scale(1, open_k)
            c.drawPath(poly([(-0.08, -0.16), (0.1, -0.15), (0.08, 0.14), (-0.07, 0.13)]), fill((60, 44, 58)))
            c.drawCircle(0.02, 0.04, 0.06, fill((128, 96, 88)))
            c.drawCircle(-0.01, -0.07, 0.035, fill(PAPER))
            c.restore()
        c.drawLine(ex - 0.12, ey - 0.17 + 0.3 * (1 - open_k), ex + 0.14, ey - 0.15 + 0.3 * (1 - open_k),
                   stroke(LINE, 1, 0.05))
        c.drawCircle(hx + 0.28, hy + 0.27, 0.07, fill((240, 150, 150), 0.35))
        c.restore()

    # -- back view --------------------------------------------------------
    def back(self, c, x, y, s, sit=False, arm_up=0.0, look_up=0.0, light=(0, -1), rim=None, rim_a=0.0,
             walk=None, umbrella=0.0):
        self.px = s
        c.save()
        c.translate(x, y)
        c.scale(s, s)
        L = (light[0] * 0.09, light[1] * 0.09)
        hip_y = -0.4 if sit else -3.6
        if walk is not None:
            hip_y += abs(math.cos(walk)) * 0.08
        if sit:
            self.cel(c, poly([(-1.1, 0), (-0.9, -0.7), (0.9, -0.7), (1.1, 0)]), SKIRT, L, rim, rim_a)
        else:
            for i, sx in enumerate((-0.33, 0.33)):
                lift = max(0.0, math.sin(walk + i * math.pi)) * 0.3 if walk is not None else 0.0
                self.cel(c, capsule(sx * 1.1, -1.4 - lift, sx * 1.1, -0.3 - lift, 0.18, 0.15), SKIN, L)
                self.cel(c, capsule(sx * 1.1 - 0.13, -0.1 - lift, sx * 1.1 + 0.13, -0.1 - lift, 0.17, 0.17),
                         SHOES, L)
            sk = self.wind * 0.3 * math.sin(self.t * 2.1)
            self.cel(c, poly([(-0.62, hip_y - 0.35), (0.62, hip_y - 0.35), (1.0 + sk, hip_y + 2.25),
                              (-0.98 + sk, hip_y + 2.3)]), SKIRT, L, rim, rim_a)
        ny = hip_y - 2.45
        body = skia.Path()
        body.moveTo(-0.7, hip_y + 0.1)
        body.cubicTo(-0.82, hip_y - 1.3, -0.95, ny + 0.6, -0.55, ny + 0.12)
        body.lineTo(0.55, ny + 0.12)
        body.cubicTo(0.95, ny + 0.6, 0.82, hip_y - 1.3, 0.7, hip_y + 0.1)
        body.close()
        self.cel(c, body, JACKET, L, rim, rim_a)
        c.drawLine(-0.45, ny + 0.2, 0.62, hip_y - 0.1, stroke(STRAP, 1, 0.12))
        self.cel(c, capsule(-0.78, ny + 0.4, -0.92, ny + 2.0, 0.22, 0.17), JACKET, L, rim, rim_a)
        self.cel(c, capsule(-0.92, ny + 2.0, -0.95, ny + 2.3, 0.13, 0.11), SKIN, L)
        a = math.radians(lerp(8, 150, ease_in_out(arm_up)) if not umbrella else 160)
        ex, ey = 0.78 + math.sin(a) * 1.0, ny + 0.4 + math.cos(a) * 1.0 if not umbrella else ny + 1.2
        if umbrella:
            ex, ey = 0.7, ny + 1.3
            wx, wy = 0.3, ny + 0.6
        else:
            wx, wy = ex + math.sin(a * 1.05) * 1.1, ey + math.cos(a * 1.05) * 1.1
        self.cel(c, capsule(0.78, ny + 0.4, ex, ey, 0.22, 0.18), JACKET, L, rim, rim_a)
        self.cel(c, capsule(ex, ey, wx, wy, 0.18, 0.15), JACKET, L, rim, rim_a)
        self.cel(c, capsule(wx, wy, wx + 0.05, wy - 0.25, 0.12, 0.1), SKIN, L)
        c.save()
        c.translate(0, ny)
        c.rotate(-6 * look_up)
        hy = -0.95 + 0.12 * look_up
        self.cel(c, capsule(0, 0.05, 0, -0.45, 0.17, 0.17), SKIN, L)
        head = skia.Path()
        head.addOval(skia.Rect.MakeLTRB(-0.6, hy - 0.72, 0.6, hy + 0.6))
        self.cel(c, head, HAIR, L, rim, rim_a)
        for i in range(7):
            u = -0.54 + i * 0.18
            sway = self.wind * 0.2 * math.sin(self.t * (1.6 + 0.17 * i) + i * 0.8)
            strand = skia.Path()
            strand.moveTo(u - 0.14, hy)
            strand.quadTo(u * 1.15 + sway * 0.5, hy + 0.9, u * 1.05 + sway, hy + 1.5 - abs(u) * 0.3)
            strand.quadTo(u * 1.1 + 0.08, hy + 0.8, u + 0.16, hy)
            strand.close()
            self.cel(c, strand, HAIR, L, rim, rim_a)
        ring = skia.Path()
        ring.addArc(skia.Rect.MakeLTRB(-0.5, hy - 0.62, 0.5, hy + 0.2), 200, 140)
        c.drawPath(ring, stroke((150, 120, 140), 0.7, 0.07))
        c.restore()
        if umbrella:
            dome = skia.Path()
            top = ny - 2.4
            dome.moveTo(-2.4, top + 1.2)
            dome.cubicTo(-2.2, top - 0.6, 2.2, top - 0.6, 2.4, top + 1.2)
            for i in range(6):
                x0 = 2.4 - i * 0.8
                dome.quadTo(x0 - 0.4, top + 0.95, x0 - 0.8, top + 1.2)
            dome.close()
            c.drawLine(0.3, ny + 0.6, 0.0, top + 0.1, stroke((40, 40, 50), 1, 0.06))
            self.cel(c, dome, UMBRELLA, (0, 0.06), rim, rim_a)
        c.restore()


def eye_closeup(c, cx, cy, s, t, blink=0.0, look=(0.0, 0.0), reflect=None, wind=0.4):
    """One eye, filling the frame: iris with depth, two highlights, lashes, a sky reflected."""
    c.save()
    c.translate(cx, cy)
    c.scale(s, s)
    vgrad(c, -3, 3, [(0, (250, 214, 196)), (1, (236, 186, 170))], rect=skia.Rect.MakeLTRB(-6, -3, 6, 3))
    radial(c, 1.4, 0.9, 1.6, (255, 160, 160), 0.18, add=False)
    open_k = 1 - clamp(blink)
    lid = skia.Path()
    lid.moveTo(-1.55, 0.05)
    lid.cubicTo(-0.9, -0.95 * open_k - 0.05, 0.9, -1.0 * open_k - 0.05, 1.6, -0.15)
    lid.cubicTo(1.0, 0.65 * open_k + 0.02, -0.9, 0.7 * open_k + 0.05, -1.55, 0.05)
    lid.close()
    c.save()
    c.clipPath(lid, skia.ClipOp.kIntersect, True)
    c.drawPaint(fill((250, 250, 252)))
    vgrad(c, -1.2, 0, [(0, (190, 196, 214)), (1, (250, 250, 252))], rect=skia.Rect.MakeLTRB(-2, -1.2, 2, 0))
    ix, iy = look[0] * 0.3, look[1] * 0.2
    sh = skia.GradientShader.MakeLinear(points=[(0, iy - 0.75), (0, iy + 0.75)],
                                        colors=[color((40, 46, 66)), color((84, 62, 56)), color((196, 140, 88))],
                                        positions=[0, 0.45, 1])
    c.drawCircle(ix, iy, 0.75, skia.Paint(AntiAlias=True, Shader=sh))
    for k in range(36):                       # fine radial fibres of the iris
        a = k / 36 * 2 * math.pi
        c.drawLine(ix + math.cos(a) * 0.32, iy + math.sin(a) * 0.32, ix + math.cos(a) * 0.72,
                   iy + math.sin(a) * 0.72, stroke((230, 190, 140), 0.18, 0.02))
    if reflect:
        c.save()
        clip = skia.Path()
        clip.addCircle(ix, iy, 0.7)
        c.clipPath(clip, skia.ClipOp.kIntersect, True)
        reflect(c, ix, iy)
        c.restore()
    c.drawCircle(ix, iy, 0.3, fill((20, 14, 22)))
    c.drawCircle(ix, iy, 0.75, stroke((30, 22, 30), 1, 0.05))
    c.drawOval(skia.Rect.MakeLTRB(ix - 0.45, iy - 0.55, ix - 0.12, iy - 0.25), fill((255, 255, 255), 0.95))
    c.drawCircle(ix + 0.3, iy + 0.36, 0.08, fill((255, 255, 255), 0.85))
    c.restore()
    # upper lash line, its flicks, and the crease
    upper = skia.Path()
    upper.moveTo(-1.6, 0.08)
    upper.cubicTo(-0.9, -0.97 * open_k - 0.05, 0.9, -1.02 * open_k - 0.05, 1.65, -0.12)
    c.drawPath(upper, stroke((40, 24, 32), 1, 0.12))
    for k in range(4):
        u = 0.72 + k * 0.08
        x = lerp(-1.4, 1.6, u)
        y = -0.95 * open_k * math.sin(math.pi * u) - 0.05
        flick = skia.Path()
        flick.moveTo(x - 0.06, y + 0.02)
        flick.quadTo(x + 0.12, y - 0.1, x + 0.3 + 0.05 * k, y - 0.12 - 0.06 * k)
        flick.quadTo(x + 0.1, y - 0.02, x + 0.08, y + 0.04)
        flick.close()
        c.drawPath(flick, fill((40, 24, 32)))
    crease = skia.Path()
    crease.moveTo(-1.2, -0.65 - 0.4 * open_k)
    crease.cubicTo(-0.4, -1.45, 0.8, -1.5, 1.5, -0.85)
    c.drawPath(crease, stroke((200, 140, 130), 0.7, 0.05))
    lower = skia.Path()
    lower.moveTo(-1.2, 0.35)
    lower.cubicTo(-0.4, 0.75 * open_k + 0.1, 0.7, 0.7 * open_k + 0.1, 1.3, 0.25)
    c.drawPath(lower, stroke((170, 110, 110), 0.6, 0.04))
    brow = skia.Path()
    brow.moveTo(-1.6, -1.9)
    brow.cubicTo(-0.6, -2.35, 0.9, -2.3, 2.0, -1.8)
    c.drawPath(brow, stroke((70, 46, 52), 0.9, 0.12))
    # strands of hair crossing the face in the wind
    for k in range(3):
        sway = wind * 0.4 * math.sin(t * (1.2 + 0.2 * k) + k)
        hp = skia.Path()
        hp.moveTo(-3.6 + k * 0.35, -3.2)
        hp.cubicTo(-2.6 + k * 0.4 + sway, -1.5, -3.2 + k * 0.3 + sway, 0.5, -3.8 + k * 0.35 + sway, 3.2)
        c.drawPath(hp, stroke(HAIR[0], 0.9, 0.05 + 0.02 * k))
        c.drawPath(hp, stroke((140, 110, 120), 0.5, 0.015))
    c.restore()


# ---------------------------------------------------------------- world
class Film:
    def __init__(self, env, duration):
        self.env = env
        self.duration = duration
        self.surface = skia.Surface(W, H)
        self.glow = skia.Surface(W // GLOW_SCALE, H // GLOW_SCALE)
        self.blur = {s: skia.MaskFilter.MakeBlur(skia.kNormal_BlurStyle, s) for s in (1, 2, 4, 8)}
        self.girl = Student()
        rng = np.random.default_rng(1978)  # the year the school was founded
        self.petals = rng.random((420, 6))
        self.motes = rng.random((220, 4))
        self.stars = rng.random((900, 4))
        self.bokeh = rng.random((60, 5))
        self.birds = rng.random((14, 3))
        self.rain = rng.random((700, 3))
        self.cache = {}

    def tex(self, key):
        """Painted textures are made on first use, so each worker only paints what it needs."""
        if key not in self.cache:
            make = {
                "clouds_dawn": lambda: make_clouds(W + 900, 700, 3, lit=(255, 236, 214), shade=(150, 170, 210),
                                                   rim=(255, 250, 236), band=(0.2, 0.9), cover=0.55,
                                                   sun_dir=(-0.8, 0.3)),
                "clouds_gold": lambda: make_clouds(W + 900, 760, 11, lit=(255, 236, 196), shade=(120, 120, 170),
                                                   rim=(255, 250, 230), band=(0.18, 0.92), cover=0.6,
                                                   sun_dir=(0.6, 0.4)),
                "clouds_day": lambda: make_clouds(W + 900, 700, 37, lit=(255, 255, 255), shade=(150, 178, 222),
                                                  rim=(255, 255, 255), band=(0.2, 0.95), cover=0.66,
                                                  sun_dir=(-0.3, -1)),
                "clouds_eve": lambda: make_clouds(W + 900, 620, 41, lit=(255, 176, 120), shade=(84, 74, 128),
                                                  rim=(255, 226, 176), band=(0.15, 0.85), cover=0.5,
                                                  sun_dir=(0, 1)),
                "clouds_dusk": lambda: make_clouds(W + 900, 600, 23, lit=(255, 170, 150), shade=(60, 58, 112),
                                                   rim=(255, 214, 190), band=(0.15, 0.9), cover=0.5,
                                                   sun_dir=(0.9, 0.3)),
                "sea": lambda: make_cloud_sea(W + 900, 900, 61, lit=(255, 222, 200), shade=(104, 96, 156),
                                              rim=(255, 240, 222)),
                "tower": lambda: make_tower(1500, 1300, 71, lit=(255, 236, 200), shade=(96, 132, 176),
                                            rim=(255, 250, 236)),
                "city_dusk": lambda: make_city(W + 600, 220, 5, (40, 38, 66), (255, 210, 150), lights=0.25),
                "city_far": lambda: make_city(W + 400, 160, 6, (78, 76, 112), (255, 220, 170), lights=0.15,
                                              max_h=0.7),
                "city_night": lambda: make_city(W + 600, 300, 7, (14, 18, 40), (255, 214, 150), lights=1.0,
                                                max_h=0.9),
                "city_night_far": lambda: make_city(W + 600, 200, 8, (22, 26, 56), (210, 220, 255), lights=0.9,
                                                    max_h=0.6),
                "milky": lambda: make_milky_way(W, H, 99),
            }[key]
            self.cache[key] = make()
        return self.cache[key]

    def energy(self, t):
        return float(self.env[int(clamp(t * FPS, 0, len(self.env) - 1))])

    # -- shared pieces ----------------------------------------------------
    def clouds(self, c, key, y, pan, alpha=1.0, scale=1.0, x0=0.0):
        img = self.tex(key)
        p = skia.Paint(AntiAlias=True)
        p.setAlphaf(clamp(alpha))
        c.save()
        c.translate(x0 - (pan % 900), y)
        c.scale(scale, scale)
        c.drawImage(img, 0, 0, skia.SamplingOptions(skia.FilterMode.kLinear), p)
        c.restore()

    def sun_flare(self, c, g, sx, sy, k, tint=(255, 220, 170), gx=0.0, gy=0.0):
        if k <= 0:
            return
        G = GLOW_SCALE
        radial(c, sx, sy, 420 * k, tint, 0.5 * k)
        radial(c, sx, sy, 90, PAPER, 0.95 * min(1, k * 1.4))
        radial(g, (sx + gx) / G, (sy + gy) / G, 90 * k + 20, tint, 0.9 * k)
        streak = skia.GradientShader.MakeLinear(points=[(sx - 900, 0), (sx + 900, 0)],
                                                colors=[color(tint, 0), color(PAPER, 0.4 * k), color(tint, 0)])
        p = skia.Paint(AntiAlias=True, Shader=streak)
        additive(p)
        c.drawRect(skia.Rect.MakeLTRB(sx - 900, sy - 3, sx + 900, sy + 3), p)
        dx, dy = CX - sx, CY - sy
        for f, r, rgb, a in ((0.6, 36, (140, 255, 220), 0.10), (1.15, 64, (255, 160, 220), 0.07),
                             (1.6, 22, (160, 210, 255), 0.13), (2.0, 110, (255, 220, 160), 0.05)):
            hx, hy = sx + dx * f, sy + dy * f
            hexa = poly([(hx + r * math.cos(i * math.pi / 3), hy + r * math.sin(i * math.pi / 3)) for i in range(6)])
            p = fill(rgb, a * k)
            additive(p)
            c.drawPath(hexa, p)

    def beam(self, c, pts, k, rgb=(255, 228, 176), origin=None):
        """A shaft of light (polygon), brightest at its source."""
        if k <= 0:
            return
        ox, oy = origin or pts[0]
        far = max(math.hypot(x - ox, y - oy) for x, y in pts) or 1
        shader = skia.GradientShader.MakeRadial(center=(ox, oy), radius=far,
                                                colors=[color(rgb, 0.32 * k), color(rgb, 0.08 * k), color(rgb, 0)],
                                                positions=[0, 0.6, 1])
        p = skia.Paint(AntiAlias=True, Shader=shader)
        additive(p)
        c.drawPath(poly(pts), p)

    def rays(self, c, ox, oy, k, angle, count=9, spread=0.07, t=0.0, rgb=(255, 228, 170), length=2400):
        if k <= 0:
            return
        for i in range(count):
            a = angle + (i - count / 2) * spread + 0.02 * math.sin(t * 0.3 + i)
            w = 0.014 + 0.012 * ((i * 37) % 5) / 5
            self.beam(c, [(ox, oy), (ox + math.cos(a - w) * length, oy + math.sin(a - w) * length),
                          (ox + math.cos(a + w) * length, oy + math.sin(a + w) * length)], k * 0.7, rgb)

    def dust(self, c, t, k, area, rgb=(255, 236, 200), n=160):
        if k <= 0:
            return
        x0, y0, x1, y1 = area
        pts = []
        for mx, my, s, ph in self.motes[:n]:
            x = x0 + mx * (x1 - x0) + 30 * math.sin(t * 0.3 + ph * 7)
            y = y0 + ((my * (y1 - y0) + t * (5 + 9 * s)) % (y1 - y0))
            pts.append(skia.Point(x, y))
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts, additive(stroke(rgb, 0.55 * k, 2.4)))

    def bokeh_layer(self, c, t, k, rgb_set, area=(0, 0, W, H), drift=(8, -4), size=1.0):
        if k <= 0:
            return
        x0, y0, x1, y1 = area
        for bx, by, s, ph, hue in self.bokeh:
            x = x0 + ((bx * (x1 - x0) + t * drift[0] * (0.5 + s)) % (x1 - x0))
            y = y0 + ((by * (y1 - y0) + t * drift[1] * (0.5 + s)) % (y1 - y0))
            r = (14 + 46 * s) * size
            rgb = rgb_set[int(hue * len(rgb_set)) % len(rgb_set)]
            a = k * (0.08 + 0.1 * math.sin(t * 0.8 + ph * 6) ** 2)
            c.drawCircle(x, y, r, additive(fill(rgb, a)))
            c.drawCircle(x, y, r, additive(stroke(rgb, a * 0.8, 1.5)))

    def petals_layer(self, c, t, k, wind=1.0, count=420, area_y=(0, H), near=False):
        if k <= 0:
            return
        for px, py, s, ph, spin, depth in self.petals[:count]:
            speed = (60 + 160 * depth) * wind
            x = (px * (W + 400) + t * speed) % (W + 400) - 200
            y = area_y[0] + ((py * (area_y[1] - area_y[0]) + t * (30 + 50 * depth)
                              + 40 * math.sin(t * (0.7 + s) + ph * 6)) % (area_y[1] - area_y[0]))
            size = (3 + 9 * depth ** 1.6) * (2.4 if near else 1)
            c.save()
            c.translate(x, y)
            c.rotate(math.degrees(t * (1 + 3 * spin) + ph * 6))
            c.scale(1, 0.35 + 0.65 * abs(math.cos(t * (1.3 + spin) + ph * 5)))
            c.drawOval(skia.Rect.MakeLTRB(-size, -size * 0.6, size, size * 0.6),
                       fill(mix((255, 190, 210), (255, 236, 240), s), k * (0.6 + 0.4 * depth)))
            c.restore()

    def power_lines(self, c, x_pole, top, k, rgb=(22, 20, 34), sag=60, span=900, offset=0.0, scale=1.0):
        if k <= 0:
            return
        for i in range(-1, 4):
            px = x_pole + i * span - (offset % span)
            c.drawRect(skia.Rect.MakeLTRB(px - 7 * scale, top - 10, px + 7 * scale, H), fill(rgb, k))
            c.drawRect(skia.Rect.MakeLTRB(px - 70 * scale, top + 10, px + 70 * scale, top + 18 * scale), fill(rgb, k))
            c.drawRect(skia.Rect.MakeLTRB(px - 50 * scale, top + 46 * scale, px + 50 * scale, top + 52 * scale),
                       fill(rgb, k))
            for j, (dx, dy) in enumerate(((-64, 12), (-20, 12), (24, 12), (64, 12), (-44, 48), (44, 48))):
                p = skia.Path()
                p.moveTo(px + dx * scale, top + dy * scale)
                p.quadTo(px + dx * scale + span / 2, top + dy * scale + sag + j * 6, px + dx * scale + span,
                         top + dy * scale)
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

    def stars_layer(self, c, g, t, k, rot=0.0, centre=(CX, CY), clear_r=0.0, trails=0.0, horizon=H, gy=0.0):
        if k <= 0:
            return
        ox, oy = centre
        bright, dim, arcs = [], [], []
        for sx, sy, s, ph in self.stars:
            r = 60 + (sx ** 0.7) * 1500
            th = sy * 2 * math.pi + rot
            x, y = ox + r * math.cos(th), oy + r * math.sin(th) * 0.92
            if y > horizon or not (-40 < x < W + 40) or y < -40 - gy:
                continue
            fade = smooth((r - clear_r) / 120) if clear_r else 1.0
            if fade <= 0:
                continue
            tw = 0.6 + 0.4 * math.sin(t * (1 + 2 * s) + ph * 9)
            if trails > 0:
                arcs.append((r, th, s, fade))
            (bright if s > 0.85 else dim).append((skia.Point(x, y), tw * fade))
        for r, th, s, fade in arcs:
            span = math.degrees(trails * (0.4 + 0.6 * s))
            rect = skia.Rect.MakeXYWH(ox - r, oy - r * 0.92, 2 * r, 2 * r * 0.92)
            c.drawArc(rect, math.degrees(th) - span, span, False,
                      stroke(mix((190, 210, 255), BRASS, s * 0.6), k * 0.5 * fade * trails, 1.2))
        p = stroke(PAPER, k, 3.2)
        for pt, a in bright:
            p.setColor(color(PAPER, k * a))
            c.drawPoints(skia.Canvas.kPoints_PointMode, [pt], p)
        c.drawPoints(skia.Canvas.kPoints_PointMode, [pt for pt, _ in dim], stroke((210, 220, 255), k * 0.55, 1.6))
        gp = additive(stroke(PAPER, k * 0.7, 2.5))
        gp.setMaskFilter(self.blur[1])
        g.drawPoints(skia.Canvas.kPoints_PointMode,
                     [skia.Point(pt.x() / GLOW_SCALE, (pt.y() + gy) / GLOW_SCALE) for pt, _ in bright], gp)

    def window_sky(self, c, t, rect_path, sun, k_sun=1.0, g=None):
        """The dawn sky seen through a window: gradient, drifting cloud, the sun."""
        c.save()
        c.clipPath(rect_path, skia.ClipOp.kIntersect, True)
        vgrad(c, 0, H, [(0, (120, 180, 236)), (0.5, (214, 226, 240)), (0.8, (255, 214, 170)), (1, (255, 190, 140))])
        self.clouds(c, "clouds_dawn", 120, 200 + t * 9)
        radial(c, sun[0], sun[1], 360, (255, 220, 170), 0.7 * k_sun)
        radial(c, sun[0], sun[1], 80, PAPER, 0.95 * k_sun)
        c.restore()
        if g is not None:
            radial(g, sun[0] / GLOW_SCALE, sun[1] / GLOW_SCALE, 50, (255, 230, 190), 0.8 * k_sun)

    # ================================================================ shots
    # 1. Dawn, the empty classroom (0.6 - 8.5 s)
    def s_classroom(self, c, g, t):
        k_in = smooth((t - CUES["intro_in"]) / 2.8)
        push = ease_in_out(t / 8.5)
        e = self.energy(t)
        c.save()
        z = 1.0 + 0.12 * push
        c.translate(CX, CY)
        c.scale(z, z)
        c.translate(-CX - 40 * push, -CY)
        P = Persp(1060, 470, 820)
        # walls, floor, ceiling
        c.drawPath(P.quad((-6, -4, 1.2), (6, -4, 1.2), (6, -4, 14), (-6, -4, 14)), fill((196, 190, 186)))
        c.drawPath(P.quad((-6, 3, 1.2), (6, 3, 1.2), (6, 3, 14), (-6, 3, 14)), fill((150, 120, 104)))
        for zz in range(2, 15):
            c.drawLine(*P.p(-6, 3, zz), *P.p(6, 3, zz), stroke((120, 92, 80), 0.6, 1.2))
        c.drawPath(P.quad((6, -4, 1.2), (6, -4, 14), (6, 3, 14), (6, 3, 1.2)), fill((214, 206, 196)))
        c.drawPath(P.quad((-6, -4, 1.2), (-6, -4, 14), (-6, 3, 14), (-6, 3, 1.2)), fill((172, 164, 160)))
        back = P.quad((-6, -4, 14), (6, -4, 14), (6, 3, 14), (-6, 3, 14))
        c.drawPath(back, fill((206, 200, 192)))
        # the blackboard: dark green, chalk dust, never a word on it
        c.drawPath(P.quad((-4.2, -2.6, 13.95), (3.6, -2.6, 13.95), (3.6, 0.2, 13.95), (-4.2, 0.2, 13.95)),
                   fill((40, 70, 62)))
        bx0, by0 = P.p(-4.2, -2.6, 13.95)
        bx1, by1 = P.p(3.6, 0.2, 13.95)
        for i in range(4):
            radial(c, lerp(bx0, bx1, 0.2 + 0.2 * i), lerp(by0, by1, 0.55 + 0.1 * (i % 2)), 80, (220, 230, 220), 0.05,
                   add=False)
        c.drawPath(P.quad((-4.3, 0.2, 13.9), (3.7, 0.2, 13.9), (3.7, 0.32, 13.6), (-4.3, 0.32, 13.6)),
                   fill((150, 140, 130)))
        # ceiling lights, off; a clock-less, sign-less room
        for zz in (3, 6, 9, 12):
            for xx in (-3, 3):
                c.drawPath(P.quad((xx - 0.9, -3.98, zz), (xx + 0.9, -3.98, zz), (xx + 0.9, -3.98, zz + 0.4),
                                  (xx - 0.9, -3.98, zz + 0.4)), fill((236, 236, 236)))
        # windows on the left wall with the dawn sky
        sun = P.p(-6, -0.4, 5.5 + 0.4 * t / 8)
        for z0, z1 in ((2.0, 4.6), (5.4, 8.0), (8.8, 11.2), (11.8, 13.4)):
            win = P.quad((-5.98, -2.8, z0), (-5.98, -2.8, z1), (-5.98, 1.0, z1), (-5.98, 1.0, z0))
            self.window_sky(c, t, win, (sun[0] - 900, sun[1]), 1.0 if z0 < 6 else 0.0, g)
            c.drawPath(win, stroke((90, 84, 86), 1, 7))
            mx = (z0 + z1) / 2
            c.drawLine(*P.p(-5.98, -2.8, mx), *P.p(-5.98, 1.0, mx), stroke((90, 84, 86), 1, 5))
            c.drawLine(*P.p(-5.98, -0.9, z0), *P.p(-5.98, -0.9, z1), stroke((90, 84, 86), 1, 4))
            # sunlight laid across the floor and the desks, and the shaft through the air
            fl = [P.p(-6 + 3.8 * 1.3, 3, z0 + 1.0), P.p(-6 + 3.8 * 1.3, 3, z1 + 1.0), P.p(-6 + 0.2, 3, z1 + 0.2),
                  P.p(-6 + 0.2, 3, z0 + 0.2)]
            c.drawPath(poly(fl), additive(fill((255, 200, 140), 0.22 + 0.1 * e)))
            self.beam(c, [P.p(-6, -2.8, z0), P.p(-6, -2.8, z1), fl[1], fl[0]], 0.9 + 0.4 * e, origin=P.p(-6, -1, mx))
        # desks and chairs in rows, each top catching a strip of light
        for zz in (12.0, 9.8, 7.6, 5.4, 3.6):
            for xx in (-3.6, -1.0, 1.6, 4.2):
                top = P.quad((xx - 0.8, 0.9, zz), (xx + 0.8, 0.9, zz), (xx + 0.8, 0.9, zz + 0.9), (xx - 0.8, 0.9, zz + 0.9))
                c.drawPath(top, fill((186, 146, 108)))
                c.drawPath(P.quad((xx - 0.8, 0.9, zz), (xx + 0.8, 0.9, zz), (xx + 0.8, 1.05, zz), (xx - 0.8, 1.05, zz)),
                           fill((120, 88, 66)))
                for lx in (xx - 0.72, xx + 0.72):
                    c.drawLine(*P.p(lx, 1.05, zz), *P.p(lx, 3, zz), stroke((70, 70, 80), 1, max(1.0, 18 / zz)))
                c.drawPath(P.quad((xx - 0.55, 1.5, zz - 0.7), (xx + 0.55, 1.5, zz - 0.7), (xx + 0.55, 1.5, zz - 0.15),
                                  (xx - 0.55, 1.5, zz - 0.15)), fill((140, 106, 82)))
                c.drawPath(P.quad((xx - 0.5, 0.75, zz - 0.72), (xx + 0.5, 0.75, zz - 0.72), (xx + 0.5, 1.15, zz - 0.72),
                                  (xx - 0.5, 1.15, zz - 0.72)), fill((150, 116, 90)))
                for lx in (xx - 0.45, xx + 0.45):
                    c.drawLine(*P.p(lx, 1.5, zz - 0.4), *P.p(lx, 3, zz - 0.4), stroke((70, 70, 80), 1, max(1.0, 12 / zz)))
                if xx < 0:
                    c.drawPath(P.quad((xx - 0.8, 0.9, zz), (xx - 0.1, 0.9, zz), (xx - 0.1, 0.9, zz + 0.9),
                                      (xx - 0.8, 0.9, zz + 0.9)), additive(fill((255, 214, 160), 0.18)))
        self.dust(c, t, 1.0, (100, 160, 1300, 900))
        c.restore()
        if k_in < 1:
            c.drawPaint(fill((0, 0, 0), 1 - k_in))

    # 2. The corridor: she walks away into the light (8.5 - 14.5 s)
    def s_corridor(self, c, g, t):
        lt = t - 8.5
        e = self.energy(t)
        P = Persp(CX, 500, 900)
        c.drawPath(P.quad((-3, -3.5, 1), (3, -3.5, 1), (3, -3.5, 40), (-3, -3.5, 40)), fill((206, 204, 200)))
        c.drawPath(P.quad((-3, 3, 1), (3, 3, 1), (3, 3, 40), (-3, 3, 40)), fill((178, 172, 166)))
        c.drawPath(P.quad((-3, -3.5, 1), (-3, -3.5, 40), (-3, 3, 40), (-3, 3, 1)), fill((222, 218, 210)))
        c.drawPath(P.quad((3, -3.5, 1), (3, -3.5, 40), (3, 3, 40), (3, 3, 1)), fill((200, 196, 190)))
        # the bright end of the corridor
        end = P.quad((-3, -3.5, 40), (3, -3.5, 40), (3, 3, 40), (-3, 3, 40))
        self.window_sky(c, t, end, P.p(0.5, -0.5, 40), 1.0, g)
        radial(g, CX / GLOW_SCALE, P.p(0, 0, 40)[1] / GLOW_SCALE, 60, PAPER, 0.8)
        # windows down the right wall; light pools on the polished floor and their reflections
        for z0 in range(2, 38, 4):
            z1 = z0 + 2.6
            win = P.quad((2.98, -2.4, z0), (2.98, -2.4, z1), (2.98, 0.8, z1), (2.98, 0.8, z0))
            self.window_sky(c, t, win, P.p(3, -1, z0 + 1), 0.0)
            c.drawPath(win, stroke((120, 120, 130), 1, max(1.0, 14 / z0)))
            pool = P.quad((2.9, 3, z0 + 0.8), (2.9, 3, z1 + 0.8), (-1.8, 3, z1 + 2.2), (-1.8, 3, z0 + 2.2))
            c.drawPath(pool, additive(fill((255, 206, 150), 0.26 + 0.1 * e)))
            self.beam(c, [P.p(2.98, -2.4, z0), P.p(2.98, -2.4, z1), P.p(-1.8, 3, z1 + 2.2), P.p(-1.8, 3, z0 + 2.2)],
                      0.55, origin=P.p(3, -1, z0 + 1.3))
            refl = P.quad((2.98, 3.02, z0), (2.98, 3.02, z1), (1.8, 3.02, z1), (1.8, 3.02, z0))
            c.drawPath(refl, additive(fill((220, 230, 255), 0.12)))
        # classroom doors on the left
        for z0 in range(3, 36, 6):
            c.drawPath(P.quad((-2.98, -2.2, z0), (-2.98, -2.2, z0 + 1.6), (-2.98, 3, z0 + 1.6), (-2.98, 3, z0)),
                       fill((150, 120, 100)))
            c.drawPath(P.quad((-2.97, -1.8, z0 + 0.3), (-2.97, -1.8, z0 + 1.3), (-2.97, -0.6, z0 + 1.3),
                              (-2.97, -0.6, z0 + 0.3)), fill((180, 200, 220)))
        # she walks away from us, small against the light
        zc = 5.5 + lt * 1.9
        x, y = P.p(-0.4, 3, zc)
        s = 0.5 * 900 / zc
        self.girl.wind = 0.3
        self.girl.back(c, x, y, s, walk=lt * 5.5, light=(0, -1), rim=(255, 230, 190), rim_a=0.9)
        self.dust(c, t, 0.8, (300, 150, 1600, 900))

    # 3. Profile against the window sky; a blink (14.5 - 21 s)
    def s_profile(self, c, g, t):
        lt = t - 14.5
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (96, 160, 230)), (0.55, (200, 220, 240)), (1, (255, 210, 170))])
        self.clouds(c, "clouds_dawn", 160, 400 + lt * 30, 1.0, 1.3)
        self.sun_flare(c, g, 1500, 520, 0.8 + 0.3 * e)
        # window frame in soft silhouette, out of focus in front
        c.drawRect(skia.Rect.MakeLTRB(1180, -10, 1220, H + 10), fill((70, 70, 84), 0.85))
        c.drawRect(skia.Rect.MakeLTRB(-10, 820, W + 10, 860), fill((70, 70, 84), 0.85))
        self.girl.wind = 0.9
        blink = max(0.0, 1 - abs(lt - 3.2) / 0.14)
        pose = Student.stand()
        pose["head"] = -6 + 4 * math.sin(lt * 0.4)
        self.girl.side(c, 620 - lt * 6, 2480, 300, pose, facing=1, light=(1, -0.2), rim=(255, 236, 200), rim_a=1.0,
                       blink=blink)
        self.dust(c, t, 0.7, (0, 0, W, H), n=80)
        white = smooth((lt - 5.0) / 1.4)
        if white > 0:
            c.drawPaint(fill((255, 246, 230), white * 0.95))

    # 4. The river vista at golden hour: the student is a speck (21 - 31 s)
    def s_river(self, c, g, t):
        lt = t - CUES["verse1"]
        e = self.energy(t)
        hz = 700
        pan = lt * 9
        vgrad(c, 0, hz, [(0, (40, 110, 190)), (0.4, (130, 170, 220)), (0.75, (255, 190, 140)), (1, (255, 214, 160))])
        c.save()
        c.translate(-pan * 0.3, 0)
        self.clouds(c, "clouds_gold", -40, 300 + lt * 6, 1.0, 1.15)
        c.restore()
        sun = (1320 - pan * 0.4, 610)
        self.sun_flare(c, g, sun[0], sun[1], 0.75 + 0.35 * e, tint=(255, 200, 140))
        self.rays(c, sun[0], sun[1], 0.5 + 0.3 * e, -math.pi / 2, count=12, spread=0.22, t=t)
        c.drawImage(self.tex("city_far"), -100 - pan * 0.5, hz - 140)
        c.drawImage(self.tex("city_dusk"), -200 - pan * 0.7, hz - 180)
        vgrad(c, hz, H, [(0, (255, 200, 150)), (0.25, (170, 140, 160)), (1, (30, 50, 80))])
        for i in range(80):
            y = hz + 3 + (i ** 1.6) * 0.8
            if y > H:
                break
            w = 30 + i * 8
            x = sun[0] + 220 * math.sin(i * 1.7 + lt * (0.4 + i * 0.01)) - w / 2
            c.drawRect(skia.Rect.MakeXYWH(x, y, w, 2 + i * 0.04), additive(fill((255, 230, 180), 0.5 * (1 - i / 80))))
        # embankment, wet steps, grass; power lines march along the river
        c.drawPath(poly([(-50, 940), (W + 50, 890), (W + 50, H + 10), (-50, H + 10)]), fill((40, 46, 58)))
        c.drawLine(-50, 940, W + 50, 890, stroke((255, 200, 150), 0.6, 3))
        grass = []
        for i in range(340):
            gx = (i * 5.8 + 13 * math.sin(i) - pan * 1.2) % (W + 40) - 20
            gy = 975 - 36 * math.sin(i * 0.37) + 30
            hgt = 40 + 70 * ((i * 53) % 7) / 7
            sway = 12 * math.sin(lt * 1.3 + i * 0.3)
            grass.extend((skia.Point(gx, gy + 60), skia.Point(gx + sway, gy - hgt + 60)))
        c.drawPoints(skia.Canvas.kLines_PointMode, grass, stroke((26, 34, 40), 1, 2.4))
        self.power_lines(c, 260, 120, 1.0, offset=pan * 1.4, sag=90, span=1250)
        for bx, by, s in self.birds:
            x = (bx * W + lt * (60 + 40 * s)) % (W + 200) - 100
            y = 220 + by * 200 + 10 * math.sin(lt * 2 + s * 9)
            flap = math.sin(lt * (8 + 4 * s) + bx * 20) * 6
            c.drawPath(poly([(x - 10, y - flap), (x, y), (x + 10, y - flap)], close=False), stroke((40, 40, 60), 0.9, 2))
        self.girl.wind = 0.8
        self.girl.side(c, 640 + lt * 18 - pan, 925, 13, Student.walk(lt * 5.2, 0.9), light=(1, -0.2),
                       rim=(255, 214, 160), rim_a=1.0)

    # 5. Close: her steps on the embankment path (31 - 36.5 s)
    def s_steps(self, c, g, t):
        lt = t - 31
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (110, 150, 200)), (0.5, (255, 196, 150)), (1, (255, 214, 170))])
        self.clouds(c, "clouds_gold", -200, 500 + lt * 40, 0.9, 1.4)
        self.sun_flare(c, g, 1650, 560, 0.9 + 0.3 * e, tint=(255, 200, 140))
        P = Persp(CX, 600, 700)
        c.drawPath(P.quad((-30, 1, 0.5), (30, 1, 0.5), (30, 1, 60), (-30, 1, 60)), fill((150, 120, 110)))
        scroll = (lt * 2.2) % 1.2
        for i in range(60):
            zz = 0.6 + i * 1.2 - scroll
            if zz > 0.3:
                c.drawLine(*P.p(-30, 1, zz), *P.p(30, 1, zz), stroke((110, 84, 80), 0.8, max(1.0, 6 / zz)))
        for xx in range(-30, 31, 2):
            c.drawLine(*P.p(xx, 1, 0.5), *P.p(xx, 1, 60), stroke((110, 84, 80), 0.5, 1.5))
        c.drawPath(P.quad((-30, 1, 0.5), (30, 1, 0.5), (30, 1, 60), (-30, 1, 60)), additive(fill((255, 190, 130), 0.15)))
        # her long shadow, her shoes, the hem of the skirt
        self.girl.wind = 1.0
        x = 420 + lt * 140
        pose = Student.walk(lt * 4.4, 1.0)
        sh = skia.Path()
        sh.addOval(skia.Rect.MakeLTRB(x - 700, 1010, x + 60, 1070))
        c.drawPath(sh, fill((60, 40, 50), 0.35))
        self.girl.side(c, x, 1040, 300, pose, facing=1, light=(1, -0.3), rim=(255, 220, 170), rim_a=1.0)
        # grass blades blurred in the foreground
        for i in range(36):
            gx = (i * 61 - lt * 260) % (W + 200) - 100
            sway = 30 * math.sin(lt * 1.5 + i)
            p = stroke((40, 50, 40), 0.8, 10)
            p.setMaskFilter(self.blur[8])
            c.drawLine(gx, H + 20, gx + sway, H - 200 - (i * 37) % 160, p)
        self.petals_layer(c, t, 0.6, wind=1.6, count=80, near=True)

    # 6. Up the stairwell, a tall window of light (36.5 - 41.5 s)
    def s_stairwell(self, c, g, t):
        lt = t - 36.5
        e = self.energy(t)
        c.drawPaint(fill((176, 172, 176)))
        win = poly([(980, 60), (1400, 60), (1400, 760), (980, 760)])
        self.window_sky(c, t, win, (1260, 380), 1.0, g)
        c.drawPath(win, stroke((96, 96, 106), 1, 10))
        c.drawLine(1190, 60, 1190, 760, stroke((96, 96, 106), 1, 8))
        c.drawLine(980, 410, 1400, 410, stroke((96, 96, 106), 1, 8))
        self.beam(c, [(980, 60), (1400, 60), (700, H + 100), (-200, H + 100)], 1.0 + 0.5 * e, origin=(1200, 300))
        steps = []
        for i in range(14):
            x0 = -100 + i * 110
            y0 = H + 20 - i * 52
            steps.append((x0, y0))
            c.drawRect(skia.Rect.MakeLTRB(x0, y0 - 52, x0 + 110, H + 40), fill((140, 132, 136)))
            c.drawRect(skia.Rect.MakeLTRB(x0, y0 - 52, x0 + 110, y0 - 46), fill((230, 220, 214)))
        c.drawLine(-100, H - 260, 1440, H - 260 - 14 * 52, stroke((70, 70, 84), 1, 8))
        for i in range(0, 14, 2):
            x0, y0 = steps[i]
            c.drawLine(x0 + 55, y0 - 52, x0 + 55, y0 - 52 - 200, stroke((70, 70, 84), 1, 4))
        k = clamp(lt / 5)
        i = k * 10
        x = -60 + i * 110 + 50
        y = H + 20 - i * 52 - 52
        self.girl.wind = 0.2
        pose = Student.walk(lt * 4.0, 0.8)
        pose["thigh_n"] = pose["thigh_n"] + 20
        self.girl.side(c, x, y, 30, pose, facing=1, light=(1, -0.6), rim=(255, 230, 190), rim_a=1.0)
        self.dust(c, t, 1.0, (200, 100, 1400, 900))

    # 7. Cherry blossoms over the campus avenue, a vista (41.5 - 49 s)
    def s_sakura(self, c, g, t):
        lt = t - CUES["spring"]
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (40, 120, 220)), (0.55, (150, 200, 245)), (1, (226, 238, 250))])
        self.clouds(c, "clouds_day", 30, 120 + lt * 14, 1.0, 1.2)
        self.sun_flare(c, g, 360, 110, 0.7 + 0.3 * e, tint=(255, 250, 230))
        P = Persp(CX, 640, 800)
        # the teaching buildings down the avenue, rows of glinting windows
        for side in (-1, 1):
            c.drawPath(P.quad((side * 9, -9, 3), (side * 9, -9, 40), (side * 9, 3, 40), (side * 9, 3, 3)),
                       fill((226, 222, 230)))
            for zz in range(4, 40, 2):
                for yy in (-7, -4.5, -2):
                    c.drawPath(P.quad((side * 8.98, yy, zz), (side * 8.98, yy, zz + 1.1), (side * 8.98, yy + 1.4, zz + 1.1),
                                      (side * 8.98, yy + 1.4, zz)), fill((130, 180, 230)))
        c.drawPath(P.quad((-9, 3, 1), (9, 3, 1), (9, 3, 40), (-9, 3, 40)), fill((214, 200, 196)))
        c.drawPath(P.quad((-3, 3, 1), (3, 3, 1), (3, 3, 40), (-3, 3, 40)), fill((236, 224, 218)))
        # cherry trees lining the avenue, layered clusters of blossom
        for zz in (34, 26, 19, 13, 8.5):
            for side in (-1, 1):
                tx, ty = P.p(side * 5.2, 3, zz)
                sz = 800 / zz / 60
                c.drawLine(tx, ty, tx, ty - 260 * sz, stroke((74, 52, 56), 1, 14 * sz))
                c.drawLine(tx, ty - 200 * sz, tx - side * 120 * sz, ty - 330 * sz, stroke((74, 52, 56), 1, 9 * sz))
                for j in range(26):
                    ang = j * 2.4
                    r = (50 + 170 * ((j * 37) % 11) / 11) * sz
                    bx = tx - side * 40 * sz + math.cos(ang) * r * 1.3
                    by = ty - 330 * sz + math.sin(ang) * r * 0.5 + 5 * math.sin(lt * 1.2 + j)
                    rad = (46 + 30 * ((j * 13) % 5) / 5) * sz
                    rgb = mix((244, 172, 198), (255, 228, 236), ((j * 7) % 9) / 9)
                    c.drawCircle(bx, by + rad * 0.15, rad, fill(mix(rgb, (190, 120, 160), 0.35), 0.9))
                    c.drawCircle(bx, by, rad * 0.9, fill(rgb, 0.92))
        self.girl.wind = 1.0
        reach = smooth((lt - 3) / 2)
        pose = Student.stand()
        pose["arm_n"] = lerp(8, -150, reach)
        pose["fore_n"] = lerp(6, -8, reach)
        pose["head"] = lerp(0, -24, reach)
        x, y = P.p(-0.6, 3, 9)
        self.girl.side(c, x, y, 0.5 * 800 / 9, pose, facing=1, light=(-0.6, -1), rim=(255, 255, 255), rim_a=0.6)
        self.petals_layer(c, t, 1.0, wind=1.0 + 0.6 * e)
        self.petals_layer(c, t + 50, 0.85, wind=1.3, count=50, near=True)
        self.bokeh_layer(c, t, 0.3, [(255, 210, 230), (255, 250, 240)], area=(0, 0, W, 600), size=0.8)

    # 8. 细量 — her hands, a spirit level, the bubble coming to rest (49 - 55 s)
    def s_level(self, c, g, t):
        lt = t - 49
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (160, 120, 96)), (1, (120, 86, 70))])
        # sunlight through leaves on the old desk: dappled, moving
        for i in range(40):
            x = (i * 173 + 40 * math.sin(t * 0.4 + i)) % W
            y = (i * 97 + 30 * math.cos(t * 0.33 + i * 2)) % H
            r = 40 + (i * 13) % 60
            c.drawCircle(x, y, r, additive(fill((255, 214, 150), 0.12)))
        for i in range(12):
            c.drawLine(0, 60 + i * 90, W, 40 + i * 90, stroke((140, 100, 80), 0.25, 2))
        # the level: a brushed aluminium bar with a glass vial
        lx0, lx1, ly = 260, 1660, 600
        bar = skia.Rect.MakeLTRB(lx0, ly - 70, lx1, ly + 70)
        sh = skia.GradientShader.MakeLinear(points=[(0, ly - 70), (0, ly + 70)],
                                            colors=[color((236, 238, 242)), color((170, 176, 186)), color((120, 126, 140))])
        c.drawRRect(skia.RRect.MakeRectXY(bar, 14, 14), fill((40, 30, 30), 0.35))
        c.drawRRect(skia.RRect.MakeRectXY(bar, 14, 14), skia.Paint(AntiAlias=True, Shader=sh))
        for i in range(-3, 4):
            if i:
                c.drawLine(CX + i * 160, ly - 70, CX + i * 160, ly - 40, stroke((90, 96, 110), 1, 3))
        vial = skia.Rect.MakeLTRB(CX - 220, ly - 34, CX + 220, ly + 34)
        c.drawRRect(skia.RRect.MakeRectXY(vial, 34, 34), fill((60, 70, 70)))
        inner = skia.Rect.MakeLTRB(CX - 210, ly - 26, CX + 210, ly + 26)
        liq = skia.GradientShader.MakeLinear(points=[(0, ly - 26), (0, ly + 26)],
                                             colors=[color((236, 250, 170)), color((170, 210, 90))])
        c.drawRRect(skia.RRect.MakeRectXY(inner, 26, 26), skia.Paint(AntiAlias=True, Shader=liq))
        settle = ease_out((lt - 0.6) / 4.6)
        bx = CX + 150 * (1 - settle) * math.cos(lt * 3.2 * (1 - settle)) + 2 * math.sin(lt * 7) * (1 - settle)
        c.drawOval(skia.Rect.MakeLTRB(bx - 50, ly - 20, bx + 50, ly + 18), fill((255, 255, 236), 0.95))
        c.drawOval(skia.Rect.MakeLTRB(bx - 34, ly - 16, bx + 10, ly - 6), fill((255, 255, 255)))
        for mx in (CX - 60, CX + 60):
            c.drawLine(mx, ly - 26, mx, ly + 26, stroke((40, 50, 30), 1, 3))
        if settle > 0.97:
            k = smooth((lt - 5.0) / 0.3) * (1 - smooth((lt - 5.7) / 0.3))
            radial(g, CX / GLOW_SCALE, ly / GLOW_SCALE, 40, PAPER, k)
        # her two hands, steadying it
        self.girl.line = True
        for hx, flip in ((lx0 + 40, 1), (lx1 - 40, -1)):
            c.save()
            c.translate(hx, ly + 40 + 2 * math.sin(lt * 5) * (1 - settle))
            c.scale(flip * 130, 130)
            self.girl.px = 130
            L = (0.06, 0.08)
            self.girl.cel(c, capsule(-1.8, 1.6, -0.3, 0.4, 0.55, 0.42), JACKET, L)
            palm = skia.Path()
            palm.addRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(-0.55, -0.35, 0.55, 0.55), 0.3, 0.3))
            self.girl.cel(c, palm, SKIN, L)
            for k2, (fx, fl) in enumerate(((-0.4, 1.0), (-0.12, 1.15), (0.16, 1.1), (0.42, 0.9))):
                self.girl.cel(c, capsule(fx, -0.2, fx + 0.05, -0.2 - fl, 0.13, 0.11), SKIN, L)
                c.drawOval(skia.Rect.MakeLTRB(fx - 0.07, -0.2 - fl - 0.05, fx + 0.12, -0.2 - fl + 0.18),
                           fill((255, 236, 230), 0.8))
            self.girl.cel(c, capsule(0.5, 0.3, 0.95, -0.3, 0.16, 0.13), SKIN, L)
            c.restore()
        radial(c, 300, 200, 700, (255, 220, 170), 0.15 + 0.1 * e)

    # 9a. 细量 — the vernier slides into agreement (55 - 58.5 s)
    def s_vernier(self, c, g, t):
        lt = t - 55
        vgrad(c, 0, H, [(0, (30, 40, 60)), (1, (70, 60, 80))])
        self.bokeh_layer(c, t, 0.7, [(255, 200, 150), (200, 220, 255), (255, 170, 180)], size=2.2)
        slide = 1 - ease_out(lt / 2.6)
        base_y, step = 520, 40
        c.drawRect(skia.Rect.MakeLTRB(0, base_y - 160, W, base_y), fill((206, 170, 104)))
        c.drawRect(skia.Rect.MakeLTRB(0, base_y - 160, W, base_y - 150), fill(PAPER, 0.5))
        ticks = []
        for i in range(-2, W // step + 3):
            x = i * step
            L = 70 if i % 10 == 0 else 46 if i % 5 == 0 else 28
            ticks.extend((skia.Point(x, base_y), skia.Point(x, base_y - L)))
        c.drawPoints(skia.Canvas.kLines_PointMode, ticks, stroke((40, 30, 24), 1, 3, skia.Paint.kButt_Cap))
        off = 120 * slide + 6 * math.sin(lt * 9) * slide
        c.drawRect(skia.Rect.MakeLTRB(0, base_y + 8, W, base_y + 160), fill((176, 184, 198)))
        vt = []
        for i in range(-2, W // 36 + 3):
            x = CX + (i - W // 72) * 36 + off
            vt.extend((skia.Point(x, base_y + 8), skia.Point(x, base_y + 8 + (60 if i % 10 == 0 else 34))))
        c.drawPoints(skia.Canvas.kLines_PointMode, vt, stroke((24, 28, 40), 1, 3, skia.Paint.kButt_Cap))
        radial(c, 1500, 200, 600, (255, 220, 180), 0.25)
        agree = smooth((lt - 2.5) / 0.3) * (1 - smooth((lt - 3.3) / 0.3))
        if agree > 0:
            radial(c, CX, base_y + 4, 160, (255, 236, 200), 0.6 * agree)
            radial(g, CX / GLOW_SCALE, (base_y + 4) / GLOW_SCALE, 30, PAPER, agree)

    # 9b. Her eye at the instrument: the scale in the iris (58.5 - 61.5 s)
    def s_eye(self, c, g, t):
        lt = t - 58.5

        def reflect(cc, ix, iy):
            for i in range(-12, 13):
                x = ix + i * 0.06
                cc.drawLine(x, iy - 0.2, x, iy - 0.2 + (0.12 if i % 5 == 0 else 0.06), stroke(PAPER, 0.55, 0.015))
            cc.drawLine(ix - 0.8, iy - 0.2, ix + 0.8, iy - 0.2, stroke(PAPER, 0.4, 0.012))
        blink = max(0.0, 1 - abs(lt - 0.5) / 0.16)
        eye_closeup(c, CX + 60, CY + 20, 360 + 30 * lt, t, blink=blink, look=(0.2 - 0.25 * smooth(lt / 2), 0.1),
                    reflect=reflect, wind=0.5)
        radial(c, 1700, 120, 700, (255, 214, 170), 0.3)
        white = smooth((lt - 2.3) / 0.7)
        if white > 0:
            c.drawPaint(fill((255, 230, 200), white * 0.85))

    # 10. The level crossing at sunset (61.5 - 72 s)
    def s_crossing(self, c, g, t):
        lt = t - CUES["nation"]
        e = self.energy(t)
        vgrad(c, 0, 780, [(0, (40, 90, 170)), (0.4, (190, 120, 150)), (0.75, (255, 150, 110)), (1, (255, 200, 130))])
        self.clouds(c, "clouds_eve", -60, 200 + lt * 16, 1.0, 1.3)
        sun = (980, 650 - lt * 2)
        self.sun_flare(c, g, sun[0], sun[1], 0.8 + 0.6 * e, tint=(255, 190, 120))
        self.rays(c, sun[0], sun[1], 0.6, -math.pi / 2, count=14, spread=0.2, t=t)
        c.drawImage(self.tex("city_dusk"), -150, 570)
        c.drawRect(skia.Rect.MakeLTRB(0, 780, W, H + 20), fill((50, 46, 62)))
        for x0, x1 in ((-400, 860), (300, 920), (1620, 1000), (2320, 1060)):
            c.drawLine(x0, H + 20, x1, 790, stroke((255, 190, 140), 0.9, 4))
        self.power_lines(c, 140, 140, 1.0, rgb=(24, 22, 36), sag=70, span=1700, offset=lt * 3)
        blink = (int(lt * 2.4) % 2) if lt < 9 else -1
        for sx in (380, 1540):
            c.drawRect(skia.Rect.MakeLTRB(sx - 8, 380, sx + 8, 880), fill((24, 20, 30)))
            c.drawPath(poly([(sx - 60, 400), (sx + 60, 460), (sx + 60, 480), (sx - 60, 420)]), fill((235, 230, 220)))
            for j, lx in enumerate((sx - 46, sx + 46)):
                c.drawCircle(lx, 520, 24, fill((60, 14, 18)))
                if blink == j:
                    c.drawCircle(lx, 520, 20, fill((255, 70, 60)))
                    radial(g, lx / GLOW_SCALE, 520 / GLOW_SCALE, 30, (255, 60, 40), 0.9)
        gate = 1 - smooth((lt - 8.8) / 1.4)
        ang = math.radians(-80 * (1 - gate))
        for gx, side in ((420, 1), (1500, -1)):
            ex = gx + side * math.cos(ang) * 560
            ey = 720 + math.sin(ang) * 560
            c.drawPath(capsule(gx, 720, ex, ey, 8, 6), fill((240, 236, 228)))
            for i in range(1, 7, 2):
                k0, k1 = i / 7, (i + 1) / 7
                c.drawLine(lerp(gx, ex, k0), lerp(720, ey, k0), lerp(gx, ex, k1), lerp(720, ey, k1),
                           stroke((210, 50, 50), 1, 14, skia.Paint.kButt_Cap))
        self.girl.wind = 0.9
        self.girl.back(c, 980, 805, 26, light=(0, -1), rim=(255, 210, 150), rim_a=1.0)
        train_x = lerp(-3400, W + 600, smooth((lt - 0.8) / 7.6))
        if -3400 < train_x < W + 600:
            for car in range(5):
                x = train_x - car * 720
                if x + 700 < -50 or x > W + 50:
                    continue
                c.drawRect(skia.Rect.MakeXYWH(x, 530, 700, 300), fill((186, 192, 206)))
                c.drawRect(skia.Rect.MakeXYWH(x, 570, 700, 12), fill((40, 120, 110)))
                for wi in range(6):
                    c.drawRect(skia.Rect.MakeXYWH(x + 40 + wi * 110, 610, 80, 90), fill((255, 214, 160)))
                    c.drawRect(skia.Rect.MakeXYWH(x + 40 + wi * 110, 610, 80, 10), fill(PAPER, 0.8))
                c.drawRect(skia.Rect.MakeXYWH(x, 790, 700, 40), fill((70, 70, 84)))
                c.drawRect(skia.Rect.MakeXYWH(x - 120, 530, 900, 300), additive(fill((255, 220, 180), 0.08)))

    # 11. The rooftop under a cumulonimbus: 力量 (72 - 81.6 s)
    def s_rooftop(self, c, g, t):
        lt = t - 72
        e = self.energy(t)
        tilt = ease_in_out(lt / 9.6)
        oy = tilt * 220
        vgrad(c, 0, H, [(0, (20, 90, 190)), (0.5, (90, 160, 230)), (0.85, (255, 200, 150)), (1, (255, 180, 130))])
        c.save()
        c.translate(0, oy * 0.4)
        tower = self.tex("tower")
        c.save()
        c.translate(260 - lt * 4, -380)
        c.drawImage(tower, 0, 0, skia.SamplingOptions(skia.FilterMode.kLinear))
        c.restore()
        self.clouds(c, "clouds_gold", 560, 100 + lt * 10, 0.9, 1.1)
        c.restore()
        sun = (1420 - lt * 4, 160 + oy * 0.4)
        k_sun = 0.7 + 0.5 * e + 0.6 * smooth((lt - 7) / 2.4)
        self.rays(c, sun[0], sun[1], 0.6 + 0.6 * e, math.pi * 0.65, count=16, spread=0.09, t=t)
        self.sun_flare(c, g, sun[0], sun[1], k_sun, tint=(255, 226, 180))
        c.save()
        c.translate(0, oy)
        c.drawImage(self.tex("city_far"), -200, 700)
        c.drawRect(skia.Rect.MakeLTRB(0, 860, W, H + 300), fill((96, 100, 118)))
        c.drawRect(skia.Rect.MakeLTRB(0, 860, W, 868), fill((255, 220, 180), 0.6))
        for x in range(0, W + 1, 48):
            c.drawLine(x, 740, x, 860, stroke((50, 54, 70), 1, 5))
        c.drawLine(0, 740, W, 740, stroke((50, 54, 70), 1, 8))
        c.drawLine(0, 800, W, 800, stroke((50, 54, 70), 1, 4))
        c.drawRect(skia.Rect.MakeLTRB(1560, 560, 1840, 860), fill((70, 76, 96)))
        c.drawRect(skia.Rect.MakeLTRB(1560, 560, 1600, 860), fill((255, 214, 170), 0.35))
        self.girl.wind = 1.3
        self.girl.back(c, 760, 880, 24, light=(0.5, -1), rim=(255, 226, 190), rim_a=1.0,
                       arm_up=smooth((lt - 5.5) / 2.5), look_up=smooth(lt / 4))
        c.restore()
        self.petals_layer(c, t, 0.3, wind=1.8, count=60)
        white = smooth((lt - 8.8) / 0.8)
        if white > 0:
            c.drawPaint(fill((255, 236, 210), white * 0.8))

    # 12. Above the sea of clouds at sunset (81.6 - 92 s)
    def s_cloudsea(self, c, g, t):
        lt = t - CUES["interlude"]
        e = self.energy(t)
        vgrad(c, 0, 660, [(0, (18, 30, 80)), (0.45, (90, 80, 150)), (0.8, (240, 150, 140)), (1, (255, 196, 140))])
        self.stars_layer(c, g, t, smooth(lt / 8) * 0.5, horizon=420)
        sun = (1300, 600 + lt * 3)
        self.sun_flare(c, g, sun[0], sun[1], 0.8 + 0.3 * e, tint=(255, 190, 130))
        vgrad(c, 620, H, [(0, (210, 170, 190)), (1, (90, 86, 140))])
        # the sea of cloud in three depths, each squashed by perspective and drifting at its own pace
        for y0, sy, speed, a in ((600, 0.16, 4, 0.9), (640, 0.3, 9, 1.0), (720, 0.6, 18, 1.0)):
            c.save()
            c.translate(-((100 + lt * speed) % 900), y0)
            c.scale(1.0, sy)
            p = skia.Paint(AntiAlias=True)
            p.setAlphaf(a)
            c.drawImage(self.tex("sea"), 0, 0, skia.SamplingOptions(skia.FilterMode.kLinear), p)
            c.restore()
        for px, ph, pw in ((260, 150, 300), (720, 90, 220), (1580, 120, 260)):
            c.drawPath(poly([(px - pw, 628), (px, 628 - ph), (px + pw, 628)]), fill((40, 40, 80)))
            c.drawPath(poly([(px, 628 - ph), (px + pw * 0.5, 628 - ph * 0.5), (px + pw, 628)]),
                       fill((255, 170, 130), 0.25))
        radial(c, sun[0], 640, 900, (255, 190, 150), 0.35)
        # the near peak she stands on
        peak = poly([(-40, H + 10), (-40, 860), (220, 790), (360, 830), (620, H + 10)])
        c.drawPath(peak, fill((26, 26, 50)))
        c.drawLine(220, 790, 360, 830, stroke((255, 190, 150), 0.7, 3))
        self.girl.wind = 1.2
        self.girl.back(c, 260, 800, 12, light=(1, -0.3), rim=(255, 210, 170), rim_a=1.0)

    # 13. Rain on the street, a convenience store glowing at dusk (92 - 102 s)
    def s_rain(self, c, g, t):
        lt = t - CUES["verse2"]
        e = self.energy(t)
        vgrad(c, 0, 560, [(0, (30, 44, 80)), (1, (90, 100, 140))])
        self.clouds(c, "clouds_dusk", -100, lt * 6, 0.6, 1.2)
        P = Persp(820, 560, 900)
        c.drawImage(self.tex("city_night_far"), -300, 380)
        # the store front on the right: shelves of colour, a plain sign band, no lettering
        store = P.quad((4, -3, 9), (4, -3, 30), (4, 3, 30), (4, 3, 9))
        c.drawPath(store, fill((200, 220, 230)))
        for zz in range(10, 30, 2):
            for yy in (-1.6, -0.6, 0.4, 1.4):
                c.drawPath(P.quad((3.99, yy, zz), (3.99, yy, zz + 1.6), (3.99, yy + 0.5, zz + 1.6),
                                  (3.99, yy + 0.5, zz)),
                           fill(((255, 120, 120), (120, 200, 255), (255, 220, 120), (140, 220, 150))[int(zz + yy) % 4], 0.85))
        c.drawPath(P.quad((4, -4.2, 9), (4, -4.2, 30), (4, -3, 30), (4, -3, 9)), fill((40, 150, 110)))
        c.drawPath(P.quad((4, -3.6, 9), (4, -3.6, 30), (4, -3.4, 30), (4, -3.4, 9)), fill((250, 200, 60)))
        c.drawPath(P.quad((4, -4.2, 4), (4, -4.2, 9), (4, 3, 9), (4, 3, 4)), fill((40, 44, 62)))
        radial(c, *P.p(4, 0, 13), 600, (220, 240, 255), 0.3)
        radial(g, P.p(4, 0, 13)[0] / GLOW_SCALE, P.p(4, 0, 13)[1] / GLOW_SCALE, 70, (220, 240, 255), 0.5)
        c.drawPath(P.quad((-12, 3, 1), (12, 3, 1), (12, 3, 60), (-12, 3, 60)), fill((34, 40, 60)))
        # wet asphalt: the lights pulled down into long reflections
        for (lx, lz, rgb) in ((4, 12, (220, 240, 255)), (4, 18, (220, 240, 255)), (-4, 10, (255, 200, 140)),
                              (-4, 20, (255, 200, 140)), (1.2, 18, (255, 60, 60) if lt < 6 else (80, 255, 160))):
            x, y = P.p(lx, 3, lz)
            sh = skia.GradientShader.MakeLinear(points=[(0, y), (0, H)], colors=[color(rgb, 0.5), color(rgb, 0)])
            p = skia.Paint(AntiAlias=True, Shader=sh)
            additive(p)
            c.drawRect(skia.Rect.MakeLTRB(x - 30 * 10 / lz, y, x + 30 * 10 / lz, H), p)
        # street lamps and the traffic signal
        for lz in (10, 20, 30):
            x0, y0 = P.p(-4, 3, lz)
            x1, y1 = P.p(-4, -5, lz)
            c.drawLine(x0, y0, x1, y1, stroke((20, 24, 36), 1, max(2.0, 40 / lz)))
            radial(c, x1, y1, 260 * 10 / lz, (255, 200, 140), 0.5)
            radial(g, x1 / GLOW_SCALE, y1 / GLOW_SCALE, 30 * 10 / lz, (255, 200, 140), 0.9)
        sx, sy = P.p(1.2, -3.2, 18)
        c.drawRect(skia.Rect.MakeLTRB(sx - 8, sy, sx + 8, sy + 60), fill((20, 20, 30)))
        sig = (255, 60, 60) if lt < 6 else (80, 255, 160)
        c.drawCircle(sx, sy + (12 if lt < 6 else 44), 8, fill(sig))
        radial(g, sx / GLOW_SCALE, (sy + 30) / GLOW_SCALE, 14, sig, 0.9)
        # the crossing stripes
        for i in range(-6, 7):
            c.drawPath(P.quad((i * 1.0 - 0.3, 3, 14), (i * 1.0 + 0.3, 3, 14), (i * 1.0 + 0.3, 3, 16.5),
                              (i * 1.0 - 0.3, 3, 16.5)), fill((200, 204, 214), 0.6))
        # she waits under her umbrella, then crosses on green
        walk = max(0.0, lt - 6.2)
        zc = 13.4 + walk * 0.8
        x, y = P.p(-2.4 + walk * 0.25, 3, zc)
        self.girl.wind = 0.2
        self.girl.back(c, x, y, 0.5 * 900 / zc, walk=lt * 5 if walk > 0 else None, umbrella=1.0,
                       light=(1, -0.5), rim=(220, 240, 255), rim_a=0.8)
        # rain: streaks and splashes
        lines = []
        for rx, ry, s in self.rain:
            x = (rx * (W + 200) + t * 120) % (W + 200) - 100
            y = (ry * (H + 200) + t * (1400 + 600 * s)) % (H + 200) - 100
            lines.extend((skia.Point(x, y), skia.Point(x - 6, y - 40 - 30 * s)))
        c.drawPoints(skia.Canvas.kLines_PointMode, lines, stroke((200, 214, 240), 0.35, 1.4))
        for i, (rx, ry, s) in enumerate(self.rain[:90]):
            ph = (t * 1.8 + s * 7) % 1
            x = rx * W
            y = 640 + ry * 440
            c.drawOval(skia.Rect.MakeLTRB(x - 30 * ph, y - 6 * ph, x + 30 * ph, y + 6 * ph),
                       stroke((210, 226, 255), 0.5 * (1 - ph), 1.2))
        del e

    # 14. 精思国计 — the city and the river from the hill at dusk (102 - 112.5 s)
    def s_city(self, c, g, t):
        lt = t - 102
        e = self.energy(t)
        push = ease_in_out(lt / 10.5)
        c.save()
        z = 1 + 0.06 * push
        c.translate(CX, CY)
        c.scale(z, z)
        c.translate(-CX, -CY)
        hz = 560
        vgrad(c, 0, hz, [(0, (20, 36, 90)), (0.5, (120, 90, 150)), (0.85, (250, 150, 130)), (1, (255, 190, 140))])
        self.clouds(c, "clouds_dusk", -40, 200 + lt * 8, 1.0, 1.2)
        self.sun_flare(c, g, 560, hz - 10, 0.55 + 0.2 * e, tint=(255, 180, 130))
        P = Persp(CX, hz, 700)
        vgrad(c, hz, H, [(0, (70, 60, 100)), (1, (12, 16, 34))])
        # the river winding to the horizon, holding the sky
        river = skia.Path()
        pts_l, pts_r = [], []
        for i in range(60):
            zz = 1.5 + i ** 1.5 * 0.5
            xx = 6 * math.sin(i * 0.18) + 2
            wdt = 4.0
            pts_l.append(P.p(xx - wdt, 3, zz))
            pts_r.append(P.p(xx + wdt, 3, zz))
        river.addPoly([skia.Point(*p) for p in pts_l + pts_r[::-1]], True)
        sh = skia.GradientShader.MakeLinear(points=[(0, hz), (0, H)],
                                            colors=[color((255, 196, 150)), color((120, 100, 160)), color((40, 40, 80))])
        c.drawPath(river, skia.Paint(AntiAlias=True, Shader=sh))
        # city blocks on both banks, lights coming on as she looks
        on = smooth((lt - 2) / 7)
        dots = []
        for i in range(1400):
            u, v = ((i * 0.6180339) % 1), ((i * 0.7548776) % 1)
            zz = 2 + v ** 2 * 90
            xx = (u - 0.5) * 60
            rx = 6 * math.sin((zz / 0.5) ** (1 / 1.5) * 0.18) + 2
            if abs(xx - rx) < 4.6:
                continue
            if ((i * 7919) % 100) / 100 > on:
                continue
            dots.append(skia.Point(*P.p(xx, 3, zz)))
        c.drawPoints(skia.Canvas.kPoints_PointMode, dots, additive(stroke((255, 214, 160), 0.8, 2.2)))
        for k in range(8):
            zz = 4 + k * 9
            c.drawLine(*P.p(-40, 3, zz), *P.p(40, 3, zz), additive(stroke((255, 190, 140), 0.1 * on, 1.2)))
        # bridges across the river
        for zz in (6, 18, 40):
            rx = 6 * math.sin((zz / 0.5) ** (1 / 1.5) * 0.18) + 2
            c.drawLine(*P.p(rx - 6, 2.9, zz), *P.p(rx + 6, 2.9, zz), stroke((255, 220, 170), 0.8, max(1.0, 12 / zz)))
        # the hill and her, a small figure before all of it
        hill = skia.Path()
        hill.moveTo(-50, 950)
        hill.quadTo(500, 860, 1000, 1000)
        hill.lineTo(1000, H + 200)
        hill.lineTo(-50, H + 200)
        hill.close()
        c.drawPath(hill, fill((10, 14, 28)))
        grass = []
        for i in range(160):
            gx = i * 6.2
            gy = 950 - 90 * math.sin(i / 160 * math.pi) * (1 - i / 320)
            sway = 6 * math.sin(lt * 1.4 + i * 0.4)
            grass.extend((skia.Point(gx, gy), skia.Point(gx + sway, gy - 18 - (i * 13) % 14)))
        c.drawPoints(skia.Canvas.kLines_PointMode, grass, stroke((10, 14, 28), 1, 2))
        self.girl.wind = 0.9
        self.girl.back(c, 420, 905, 15, light=(0.2, -1), rim=(255, 190, 150), rim_a=0.9)
        c.restore()

    # 15. The stone stairway at dusk, lanterns lit (112.5 - 125 s)
    def s_stairs(self, c, g, t):
        lt = t - CUES["lattice"]
        e = self.energy(t)
        vgrad(c, 0, H, [(0, (12, 18, 50)), (0.6, (70, 60, 120)), (1, (200, 120, 130))])
        self.stars_layer(c, g, t, smooth(lt / 6) * 0.8, horizon=520)
        P = Persp(CX, 430, 700)
        c.drawRect(skia.Rect.MakeLTRB(0, 600, W, H), fill((10, 14, 26)))
        # trees closing in from both sides
        for side in (-1, 1):
            for k in range(7):
                x = CX + side * (260 + k * 140)
                r = 200 + k * 60
                c.drawCircle(x, 300 + k * 60, r, fill((14, 20, 34)))
        steps = 26
        for i in range(steps, 0, -1):
            zz = 2 + i * 0.9
            y = 3 - i * 0.42
            c.drawPath(P.quad((-2.2, y, zz), (2.2, y, zz), (2.2, y, zz + 0.9), (-2.2, y, zz + 0.9)), fill((96, 92, 104)))
            c.drawPath(P.quad((-2.2, y, zz), (2.2, y, zz), (2.2, y + 0.42, zz), (-2.2, y + 0.42, zz)), fill((60, 58, 74)))
        # the pavilion at the top against the sky
        px, py = P.p(0, 3 - steps * 0.42, 2 + steps * 0.9)
        c.drawPath(poly([(px - 150, py - 70), (px, py - 130), (px + 150, py - 70), (px + 120, py - 60), (px - 120, py - 60)]),
                   fill((20, 20, 36)))
        c.drawRect(skia.Rect.MakeLTRB(px - 90, py - 60, px - 78, py), fill((20, 20, 36)))
        c.drawRect(skia.Rect.MakeLTRB(px + 78, py - 60, px + 90, py), fill((20, 20, 36)))
        # stone lanterns down both sides, each a warm glow
        for i in range(2, steps, 4):
            zz = 2 + i * 0.9
            y = 3 - i * 0.42
            for side in (-1, 1):
                x0, y0 = P.p(side * 2.8, y, zz)
                x1, y1 = P.p(side * 2.8, y - 1.4, zz)
                c.drawLine(x0, y0, x1, y1, stroke((60, 60, 74), 1, max(2.0, 30 / zz)))
                c.drawCircle(x1, y1, max(2.0, 40 / zz), fill((255, 210, 150)))
                radial(c, x1, y1, 400 / zz * 3, (255, 190, 120), 0.4)
                radial(g, x1 / GLOW_SCALE, y1 / GLOW_SCALE, 80 / zz, (255, 200, 130), 0.9)
        # fireflies
        for mx, my, s, ph in self.motes[:40]:
            x = CX + (mx - 0.5) * 1400 + 40 * math.sin(t * 0.5 + ph * 6)
            y = 400 + my * 500 + 20 * math.cos(t * 0.7 + ph * 5)
            a = 0.5 + 0.5 * math.sin(t * 2 + ph * 9)
            c.drawCircle(x, y, 2.5, fill((220, 255, 170), a))
            radial(g, x / GLOW_SCALE, y / GLOW_SCALE, 4, (200, 255, 150), a * 0.7)
        k = clamp(lt / 12.5)
        i = 4 + k * 13
        zz = 2 + i * 0.9
        y = 3 - i * 0.42
        x, yy = P.p(0.3, y, zz)
        self.girl.wind = 0.3
        self.girl.back(c, x, yy, 0.5 * 700 / zz, walk=lt * 4.2, light=(0, -1), rim=(255, 200, 150), rim_a=0.9)
        del e

    # 16. 精思国计 — night above the city: the grid, the Milky Way, a star chart (125 - 141 s)
    def s_night(self, c, g, t):
        lt = t - 125
        e = self.energy(t)
        rise = ease_in_out((lt - 11) / 5)
        oy = rise * 420
        c.save()
        c.translate(0, oy)
        vgrad(c, -700, 900, [(0, (4, 6, 22)), (0.6, (14, 22, 62)), (1, (60, 50, 110))])
        c.drawImage(self.tex("milky"), 0, -500, skia.SamplingOptions(skia.FilterMode.kLinear))
        self.stars_layer(c, g, t, 1.0, rot=t * 0.003, horizon=760, centre=(CX, CY - 200), gy=oy)
        for k, t0 in enumerate((127.2, 131.0, 136.6)):
            u = (t - t0) / 0.9
            if 0 < u < 1:
                sx = 300 + k * 520 + u * 360
                sy = -40 + k * 30 + u * 180
                sh = skia.GradientShader.MakeLinear(points=[(sx - 220, sy - 110), (sx, sy)],
                                                    colors=[color(PAPER, 0), color(PAPER, 0.9 * (1 - u))])
                c.drawLine(sx - 220, sy - 110, sx, sy,
                           skia.Paint(AntiAlias=True, Shader=sh, Style=skia.Paint.kStroke_Style, StrokeWidth=2.4))
                radial(g, sx / GLOW_SCALE, (sy + oy) / GLOW_SCALE, 10, PAPER, 1 - u)
        c.drawImage(self.tex("city_night_far"), -100, 600)
        grid_k = smooth((lt - 1) / 6)
        horizon = 780
        for i in range(1, 24):
            y = horizon + (i / 24) ** 1.8 * 320
            c.drawLine(-20, y, W + 20, y, additive(stroke((255, 200, 140), 0.12 + 0.35 * grid_k * (0.6 + 0.4 * e), 1.4)))
        for i in range(-30, 31):
            c.drawLine(CX + i * 6, horizon, CX + i * 130, H + 200, additive(stroke((255, 200, 140), 0.08 + 0.3 * grid_k, 1.2)))
        dots = []
        for i in range(900):
            u, v = ((i * 0.6180339) % 1), ((i * 0.7548776) % 1)
            y = horizon + v ** 1.8 * 320
            dots.append(skia.Point(CX + (u - 0.5) * (200 + 3600 * v ** 1.8), y))
        c.drawPoints(skia.Canvas.kPoints_PointMode, dots, additive(stroke((255, 214, 160), 0.7, 2.4)))
        radial(c, CX, horizon + 10, 700, (255, 170, 120), 0.18)
        hill = skia.Path()
        hill.moveTo(-50, 900)
        hill.quadTo(500, 840, 900, 960)
        hill.lineTo(900, H + 600)
        hill.lineTo(-50, H + 600)
        hill.close()
        c.drawPath(hill, fill((8, 10, 24)))
        self.girl.wind = 0.6
        self.girl.back(c, 430, 885, 30, sit=True, arm_up=smooth((lt - 2.5) / 2.5) * (1 - smooth((lt - 7) / 1.5)),
                       look_up=smooth(lt / 3), light=(0.4, 1), rim=(255, 200, 150), rim_a=0.7)
        c.restore()
        # insert: the star chart in her hands, its ring turned until the sky agrees
        ins = smooth((lt - 8.2) / 0.5) * (1 - smooth((lt - 11.2) / 0.5))
        if ins > 0:
            layer(c, ins)
            vgrad(c, 0, H, [(0, (6, 10, 30)), (1, (20, 24, 60))])
            self.stars_layer(c, g, t, 0.6, rot=t * 0.003)
            R = 400
            c.drawCircle(CX, CY + 40, R + 40, fill((30, 36, 70)))
            c.drawCircle(CX, CY + 40, R, fill((12, 18, 46)))
            turn = (1 - ease_out((lt - 8.2) / 2.6)) * 40
            pts = []
            for sx, sy, s, ph in self.stars[:160]:
                r = (sx ** 0.6) * (R - 20)
                a = sy * 2 * math.pi + math.radians(turn)
                pts.append(skia.Point(CX + r * math.cos(a), CY + 40 + r * math.sin(a)))
            c.drawPoints(skia.Canvas.kPoints_PointMode, pts, stroke(PAPER, 0.85, 3))
            ring = []
            for i in range(120):
                a = math.radians(i * 3 - turn * 0.5)
                l = 24 if i % 10 == 0 else 10
                ring.extend((skia.Point(CX + (R + 4) * math.cos(a), CY + 40 + (R + 4) * math.sin(a)),
                             skia.Point(CX + (R + 4 + l) * math.cos(a), CY + 40 + (R + 4 + l) * math.sin(a))))
            c.drawPoints(skia.Canvas.kLines_PointMode, ring, stroke(BRASS, 0.9, 2))
            for hx, flip in ((CX - R - 30, 1), (CX + R + 30, -1)):
                c.save()
                c.translate(hx, CY + 260)
                c.scale(flip * 120, 120)
                self.girl.px = 120
                L = (0.06, 0.08)
                palm = skia.Path()
                palm.addRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(-0.5, -0.4, 0.5, 0.6), 0.3, 0.3))
                self.girl.cel(c, capsule(-0.6, 2.0, -0.1, 0.4, 0.5, 0.4), JACKET, L)
                self.girl.cel(c, palm, SKIN, L)
                for fx in (-0.3, 0.0, 0.3):
                    self.girl.cel(c, capsule(fx, -0.3, fx + 0.35, -1.1, 0.12, 0.1), SKIN, L)
                self.girl.cel(c, capsule(0.45, 0.2, 0.9, -0.4, 0.15, 0.12), SKIN, L)
                c.restore()
            c.restore()

    # 17. The sky turns into a scale (141 - 158.1 s)
    def s_heavens(self, c, g, t):
        lt = t - CUES["converge"]
        span = CUES["ji"] - CUES["converge"]
        k = clamp(lt / span)
        vgrad(c, 0, H, [(0, (4, 6, 20)), (0.7, (10, 16, 48)), (1, (30, 30, 70))])
        p = skia.Paint()
        p.setAlphaf(1 - 0.6 * k)
        c.drawImage(self.tex("milky"), 0, -500 + 520 * (1 - k), skia.SamplingOptions(skia.FilterMode.kLinear), p)
        self.stars_layer(c, g, t, 1.0, rot=t * 0.003 + k * 0.6, clear_r=320 * smooth(k * 1.3),
                         trails=1.6 * ease_in_out(k))
        rebuild = ease_out((lt - 6) / (span - 6))
        self.dial(c, g, t, smooth((lt - 5) / 3), 300, rebuild, -90 * (1 - rebuild))
        radial(c, CX, H + 80, 900, (255, 160, 110), 0.25 * smooth((lt - 10) / 7))
        hill = skia.Path()
        hill.moveTo(-50, H - 40)
        hill.quadTo(260, H - 110, 560, H + 10)
        hill.lineTo(-50, H + 10)
        hill.close()
        c.drawPath(hill, fill((6, 8, 20), smooth((lt - 8) / 4)))
        self.girl.back(c, 250, H - 88, 15, sit=True, look_up=1.0, light=(0.3, 1), rim=(255, 190, 150),
                       rim_a=0.6 * smooth((lt - 8) / 4))

    # 18. 计量, then the afterglow (158.1 s - D)
    def s_standard(self, c, g, t):
        cu = CUES
        ji_k = clamp((t - cu["ji"]) / (cu["liang"] - cu["ji"]))
        liang_k = ease_out((t - cu["liang"]) / (cu["sung_end"] - cu["liang"]))
        vgrad(c, 0, H, [(0, (4, 6, 20)), (0.65, (12, 18, 52)), (1, mix((30, 30, 70), (130, 74, 90), liang_k))])
        self.stars_layer(c, g, t, 1.0, rot=t * 0.003 + 0.6, clear_r=320 + 120 * liang_k,
                         trails=1.6 * (1 - 0.7 * liang_k))
        radial(c, CX, H + 120, 1100, (255, 160, 110), 0.25 + 0.3 * liang_k)
        c.drawImage(self.tex("city_night_far"), -100, H - 140)
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
        a = smooth((t - cu["liang"] + 0.5) / 3.0)
        grid = []
        for x in range(0, W + 1, 96):
            grid.extend((skia.Point(x, 0), skia.Point(x, H)))
        for y in range(-12, H + 1, 96):
            grid.extend((skia.Point(0, y), skia.Point(W, y)))
        c.drawPoints(skia.Canvas.kLines_PointMode, grid, stroke(BRASS, a * 0.08, 1, skia.Paint.kButt_Cap))
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 150 + 30 * liang_k, BRASS, a * 0.3)
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 60, VERMILION, a * 0.15)
        hill = skia.Path()
        hill.moveTo(-50, H - 40)
        hill.quadTo(260, H - 110, 560, H + 10)
        hill.lineTo(-50, H + 10)
        hill.close()
        c.drawPath(hill, fill((6, 8, 20)))
        self.girl.wind = 0.5
        self.girl.back(c, 250, H - 88, 15, sit=True, look_up=1.0, light=(0.3, 1), rim=(255, 190, 150), rim_a=0.6)

    # -- frame ------------------------------------------------------------
    def frame(self, t):
        cu = CUES
        shots = [
            (0.0, 8.5, self.s_classroom), (8.5, 14.5, self.s_corridor), (14.5, cu["verse1"], self.s_profile),
            (cu["verse1"], 31.0, self.s_river), (31.0, 36.5, self.s_steps), (36.5, cu["spring"], self.s_stairwell),
            (cu["spring"], 49.0, self.s_sakura), (49.0, 55.0, self.s_level), (55.0, 58.5, self.s_vernier),
            (58.5, cu["nation"], self.s_eye), (cu["nation"], 72.0, self.s_crossing), (72.0, cu["interlude"], self.s_rooftop),
            (cu["interlude"], cu["verse2"], self.s_cloudsea), (cu["verse2"], 102.0, self.s_rain),
            (102.0, cu["lattice"], self.s_city), (cu["lattice"], 125.0, self.s_stairs), (125.0, cu["converge"], self.s_night),
            (cu["converge"], cu["ji"], self.s_heavens), (cu["ji"], self.duration + 1, self.s_standard),
        ]
        fade = 0.8
        c = self.surface.getCanvas()
        g = self.glow.getCanvas()
        g.clear(skia.ColorTRANSPARENT)
        c.clear(color(NIGHT))
        self.girl.t = t
        for i, (a, b, fn) in enumerate(shots):
            if not ((a - (fade if i else 0)) <= t < b):
                continue
            alpha = 1.0 if i == 0 else smooth((t - (a - fade)) / fade)
            layer(c, alpha)
            layer(g, alpha)
            fn(c, g, t)
            g.restore()
            c.restore()
        vig = skia.GradientShader.MakeRadial(center=(CX, CY), radius=W * 0.66,
                                             colors=[color(NIGHT, 0), color(NIGHT, 0), color(NIGHT, 0.45)],
                                             positions=[0, 0.6, 1])
        c.drawPaint(skia.Paint(Shader=vig))
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
        # the grade eases off over the closing stage, so the last frame matches the CSS layers
        return grade(self.surface.makeImageSnapshot().tobytes(), 1 - 0.5 * smooth((t - cu["liang"]) / 4))


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
