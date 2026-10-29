#!/usr/bin/env python3
"""Render the "Liangda Zhida" easter-egg film against the anthem.

The film, "The Standard", is abstract and has no text in it. A single point of
reference becomes a graduated dial, the dial becomes the Qiantang tide, the tide
seeds spring lights over the fields, the fields become a country-wide grid, and
the verse two returns through oscillation, the crystal lattice and the compass.
Everything comes back to the centre for the final "计量": the needle locks on
"计", and the ring opens across the frame on "量", leaving a calm, living field
that the CSS final stage carries on.

Every section boundary is a measured time in the anthem (CUES below), and the
anthem's loudness drives the glow, so the film is authored against the audio
rather than stretched over it. Duration = the anthem's duration, frame for frame.

Usage:
  python scripts/easteregg/render_film.py --audio public/media/anthem.mp3 \
      --out-dir public/media [--workers 4] [--preview 158]

Requires: ffmpeg, numpy, skia-python.
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

W, H = 1920, 1080
CX, CY = W / 2, H / 2
FPS = 30
GLOW_SCALE = 4  # glow layer is rendered at 1/4 size, blurred, then added back

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

# Palette: night ink, oxidised bronze, seal vermilion, tide cyan, paper.
NIGHT = (5, 7, 14)
INDIGO = (14, 22, 46)
BRASS = (226, 180, 92)
VERMILION = (217, 71, 43)
TIDE = (127, 211, 230)
PAPER = (243, 234, 216)


# ---------------------------------------------------------------- helpers
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def window(t, a, b, fade_in=1.5, fade_out=1.5):
    """1 inside [a, b], smooth fades of the given lengths outside it."""
    if t < a - fade_in or t > b + fade_out:
        return 0.0
    up = smooth((t - (a - fade_in)) / fade_in) if fade_in > 0 else float(t >= a)
    down = 1 - smooth((t - b) / fade_out) if fade_out > 0 else float(t <= b)
    return min(up, down)


def mix(c1, c2, k):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * k)) for i in range(3))


def color(rgb, a):
    return skia.ColorSetARGB(int(clamp(a) * 255), *rgb)


def stroke(rgb, a, width, cap=skia.Paint.kRound_Cap):
    p = skia.Paint(AntiAlias=True, Color=color(rgb, a), Style=skia.Paint.kStroke_Style, StrokeWidth=width)
    p.setStrokeCap(cap)
    return p


def fill(rgb, a):
    return skia.Paint(AntiAlias=True, Color=color(rgb, a), Style=skia.Paint.kFill_Style)


def additive(p):
    p.setBlendMode(skia.BlendMode.kPlus)
    return p


def radial(canvas, x, y, r, rgb, a, add=True):
    if a <= 0.002 or r <= 1:
        return
    shader = skia.GradientShader.MakeRadial(
        center=(x, y), radius=r,
        colors=[color(rgb, a), color(rgb, a * 0.35), color(rgb, 0)],
        positions=[0.0, 0.45, 1.0])
    p = skia.Paint(AntiAlias=True, Shader=shader)
    if add:
        additive(p)
    canvas.drawCircle(x, y, r, p)


def poly(points, close=False):
    path = skia.Path()
    path.addPoly([skia.Point(float(x), float(y)) for x, y in points], close)
    return path


# ---------------------------------------------------------------- audio
def loudness_envelope(audio, duration):
    """Per-frame loudness 0..1 with a slow attack/release, used to breathe the glow."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", audio, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    frames = int(round(duration * FPS))
    hop = 8000 / FPS
    env = np.zeros(frames)
    for i in range(frames):
        seg = x[int(i * hop):int((i + 1) * hop)]
        env[i] = math.sqrt(float(np.mean(seg * seg))) if len(seg) else 0.0
    db = 20 * np.log10(env + 1e-6)
    norm = np.clip((db + 42) / 30, 0, 1)
    out = np.zeros(frames)
    level = 0.0
    for i, v in enumerate(norm):
        k = 0.25 if v > level else 0.04
        level += (v - level) * k
        out[i] = level
    return out


def media_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True).stdout
    return float(json.loads(out)["format"]["duration"])


# ---------------------------------------------------------------- scene
class Scene:
    def __init__(self, env, duration):
        self.env = env
        self.duration = duration
        rng = np.random.default_rng(1978)  # the year the school was founded
        self.stars = rng.random((420, 4))
        self.seeds = rng.random((520, 5))
        self.motes = rng.random((360, 4))
        g = np.arange(-3, 4)
        self.lattice = np.array([(x, y, z) for x in g for y in g for z in g], dtype=float)
        self.surface = skia.Surface(W, H)
        self.glow = skia.Surface(W // GLOW_SCALE, H // GLOW_SCALE)
        self.blur = {s: skia.MaskFilter.MakeBlur(skia.kNormal_BlurStyle, s) for s in (2, 4, 8, 14)}

    def energy(self, t):
        i = int(clamp(t * FPS, 0, len(self.env) - 1))
        return float(self.env[i])

    # -- layers ----------------------------------------------------------
    def background(self, c, t):
        night_shift = window(t, CUES["nation"], CUES["interlude"] - 2, 6, 8) * 0.55
        top = mix(NIGHT, (24, 18, 30), night_shift)
        bottom = mix(INDIGO, (46, 26, 22), night_shift)
        shader = skia.GradientShader.MakeLinear(
            points=[(0, 0), (0, H)], colors=[color(top, 1), color(bottom, 1)])
        c.drawPaint(skia.Paint(Shader=shader))
        # slow nebula, its colour moving with the acts
        hue = mix(TIDE, BRASS, smooth((t - CUES["spring"]) / 30))
        hue = mix(hue, VERMILION, window(t, CUES["nation"], CUES["interlude"], 8, 10) * 0.6)
        hue = mix(hue, TIDE, window(t, CUES["verse2"], CUES["converge"], 8, 10) * 0.7)
        a = 0.10 + 0.08 * self.energy(t)
        radial(c, CX + 380 * math.sin(t / 23), CY - 160 + 90 * math.cos(t / 31), 900, hue, a)
        radial(c, CX - 520 * math.cos(t / 29), CY + 260, 760, mix(hue, PAPER, .3), a * .6)

    def stars_layer(self, c, t, a):
        if a <= 0:
            return
        p = stroke(PAPER, 1, 2.2)
        pts_bright, pts_dim = [], []
        for x, y, s, ph in self.stars:
            twinkle = 0.5 + 0.5 * math.sin(t * (0.6 + s) + ph * 6.28)
            px = (x * W + t * 6 * (0.3 + s)) % W
            (pts_bright if twinkle * s > 0.45 else pts_dim).append(skia.Point(px, y * H))
        p.setColor(color(PAPER, 0.55 * a))
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts_bright, p)
        p.setColor(color(PAPER, 0.22 * a))
        p.setStrokeWidth(1.4)
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts_dim, p)

    def dial(self, c, g, t, a, radius, progress, rotation, needle, rgb=BRASS, glow=1.0, locked=0.0, needle_a=1.0):
        """The graduated reference ring: 120 ticks, majors every 10, plus a needle."""
        if a <= 0:
            return
        e = self.energy(t)
        ring = stroke(rgb, 0.85 * a, 2.2)
        sweep = 360 * clamp(progress)
        rect = skia.Rect.MakeXYWH(CX - radius, CY - radius, radius * 2, radius * 2)
        c.drawArc(rect, -90 + rotation, sweep, False, ring)
        n = 120
        lit = int(n * clamp(progress))
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
        # inner fine ring
        c.drawCircle(CX, CY, radius * 0.86, stroke(rgb, 0.22 * a * clamp(progress * 2), 1))
        # needle
        if needle is not None and needle_a > 0:
            na = a * needle_a
            ang = math.radians(needle - 90)
            tip = (CX + (radius - 14) * math.cos(ang), CY + (radius - 14) * math.sin(ang))
            tail = (CX - 40 * math.cos(ang), CY - 40 * math.sin(ang))
            nc = mix(VERMILION, PAPER, locked * .4)
            c.drawLine(*tail, *tip, stroke(nc, 0.95 * na, 2.6))
            c.drawCircle(CX, CY, 5, fill(nc, na))
            gp = additive(stroke(nc, 0.7 * na * glow, 10 / GLOW_SCALE * 2))
            gp.setMaskFilter(self.blur[4])
            g.drawLine(tail[0] / GLOW_SCALE, tail[1] / GLOW_SCALE, tip[0] / GLOW_SCALE, tip[1] / GLOW_SCALE, gp)
        gp = additive(stroke(rgb, (0.35 + 0.4 * e) * a * glow, 3))
        gp.setMaskFilter(self.blur[4])
        s = GLOW_SCALE
        g.drawArc(skia.Rect.MakeXYWH((CX - radius) / s, (CY - radius) / s, 2 * radius / s, 2 * radius / s),
                  -90 + rotation, sweep, False, gp)

    def reference_point(self, c, g, t, a, size=1.0):
        if a <= 0:
            return
        e = self.energy(t)
        c.drawCircle(CX, CY, 3.2 * size, fill(PAPER, a))
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, (26 + 30 * e) * size, BRASS, 0.9 * a)
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 9 * size, PAPER, 0.8 * a)

    def tide(self, c, g, t, a):
        """The Qiantang tide: perspective sine lines with a travelling bore."""
        if a <= 0:
            return
        e = self.energy(t)
        horizon = CY - 40
        lines = 30
        bore_x = ((t - CUES["verse1"]) * 70) % (W + 900) - 450
        for k in range(lines):
            depth = (k + 1) / lines              # 0 far .. 1 near
            y0 = horizon + (H - horizon + 120) * depth ** 1.8
            amp = 4 + 26 * depth * (0.6 + 0.6 * e)
            freq = 0.004 + 0.006 * (1 - depth)
            speed = 0.5 + 1.3 * depth
            pts = []
            for i in range(97):
                x = -40 + i * (W + 80) / 96
                bump = 46 * depth * math.exp(-((x - bore_x) / (220 + 200 * depth)) ** 2)
                y = y0 + amp * math.sin(x * freq - t * speed + k * 0.7) - bump
                pts.append((x, y))
            rgb = mix(TIDE, BRASS, 0.25 + 0.5 * math.exp(-((k - 12) / 8) ** 2))
            c.drawPath(poly(pts), stroke(rgb, a * (0.16 + 0.5 * depth), 0.8 + 1.6 * depth))
            if k % 3 == 0:
                gp = additive(stroke(rgb, a * 0.35 * depth * (0.6 + e), 2))
                gp.setMaskFilter(self.blur[2])
                g.drawPath(poly([(x / GLOW_SCALE, y / GLOW_SCALE) for x, y in pts[::2]]), gp)
        radial(g, bore_x / GLOW_SCALE, (horizon + 120) / GLOW_SCALE, 70, PAPER, a * 0.25 * (0.5 + e))

    def seeds_layer(self, c, g, t, a):
        """Spring: lights rising out of the fields, blossoming as they climb."""
        if a <= 0:
            return
        base = CUES["spring"] - 4
        pts = {0: [], 1: [], 2: []}
        for x, y, s, ph, hue in self.seeds:
            life = 9 + 9 * s
            local = ((t - base) + ph * life) % life
            born = t - base - local
            if born < -life * 0.2:
                continue
            k = local / life
            px = x * W + 60 * math.sin(local * 0.6 + ph * 9) + 30 * k
            py = H * (0.62 + 0.38 * y) - k * (H * 0.55) * (0.5 + s)
            fade = math.sin(math.pi * k)
            pts[int(hue * 2.99)].append((px, py, fade))
        for idx, rgb in ((0, BRASS), (1, PAPER), (2, VERMILION)):
            for bucket in (0.35, 0.7, 1.0):
                sel = [skia.Point(px, py) for px, py, f in pts[idx] if bucket - 0.35 < f <= bucket]
                if sel:
                    c.drawPoints(skia.Canvas.kPoints_PointMode, sel, stroke(rgb, a * bucket * 0.9, 2.6 + bucket * 2))
            gsel = [skia.Point(px / GLOW_SCALE, py / GLOW_SCALE) for px, py, f in pts[idx] if f > 0.6]
            if gsel:
                gp = additive(stroke(rgb, a * 0.5 * (0.6 + self.energy(t)), 3.5))
                gp.setMaskFilter(self.blur[2])
                g.drawPoints(skia.Canvas.kPoints_PointMode, gsel, gp)

    def field_grid(self, c, g, t, a, lift=0.0, dawn=0.0):
        """A perspective plane of measured squares running to the horizon."""
        if a <= 0:
            return
        e = self.energy(t)
        horizon = CY - 60 - 140 * lift
        cam_h = 260 + 900 * lift
        focal = 900
        scroll = (t * 0.9) % 1.0
        rgb = mix(BRASS, PAPER, 0.2)
        # depth lines
        for k in range(1, 46):
            z = k - scroll
            if z <= 0.2:
                continue
            y = horizon + cam_h * focal / (z * 180) / 4.5
            if y > H + 10:
                continue
            fade = clamp(1.2 - z / 46) * a
            c.drawLine(0, y, W, y, stroke(rgb, 0.32 * fade, 1.1))
        # meridians, converging on the vanishing point
        for k in range(-26, 27):
            x_far = CX + k * 4
            x_near = CX + k * 160 * (1 + lift)
            fade = a * (0.32 - 0.006 * abs(k))
            if fade > 0:
                c.drawLine(x_far, horizon, x_near, H + 40, stroke(rgb, fade, 1.1))
        # surveyed points on the crossings, pulsing with the anthem
        pts = []
        for k in range(1, 22, 2):
            z = k - scroll
            if z <= 0.4:
                continue
            y = horizon + cam_h * focal / (z * 180) / 4.5
            for m in range(-12, 13, 3):
                x = CX + m * 160 * (1 + lift) * (y - horizon) / (H + 40 - horizon)
                pts.append(skia.Point(x, y))
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts, stroke(PAPER, a * (0.35 + 0.4 * e), 3.2))
        # the dawn behind the horizon
        if dawn > 0:
            radial(g, CX / GLOW_SCALE, horizon / GLOW_SCALE, 160 + 60 * e, VERMILION, dawn * 0.55 * a)
            radial(g, CX / GLOW_SCALE, horizon / GLOW_SCALE, 70, BRASS, dawn * 0.7 * a)
            band = skia.GradientShader.MakeLinear(
                points=[(0, horizon - 2), (0, horizon + 2)],
                colors=[color(PAPER, 0), color(PAPER, 0.8 * dawn * a)])
            c.drawRect(skia.Rect.MakeLTRB(0, horizon - 1, W, horizon + 1.5), skia.Paint(Shader=band))

    def astrolabe(self, c, g, t, a, scale=1.0):
        if a <= 0:
            return
        e = self.energy(t)
        for i, (r, tilt, speed, rgb) in enumerate((
                (420, 0.32, 0.05, BRASS), (520, 0.55, -0.035, PAPER),
                (330, 0.8, 0.07, TIDE), (610, 0.2, 0.02, BRASS))):
            r *= scale
            spin = t * speed + i
            pts = []
            for j in range(181):
                th = j / 180 * 2 * math.pi
                x, y = r * math.cos(th), r * math.sin(th) * tilt
                x, y = x * math.cos(spin * .2) - y * math.sin(spin * .2), x * math.sin(spin * .2) + y * math.cos(spin * .2)
                pts.append((CX + x, CY + y))
            c.drawPath(poly(pts, True), stroke(rgb, a * 0.42, 1.3))
            ticks = []
            for j in range(0, 180, 6):
                x, y = pts[(j + int(t * 40 * speed * 10)) % 180]
                ticks.append(skia.Point(x, y))
            c.drawPoints(skia.Canvas.kPoints_PointMode, ticks, stroke(rgb, a * 0.8, 3))
            gp = additive(stroke(rgb, a * 0.25 * (0.5 + e), 2))
            gp.setMaskFilter(self.blur[2])
            g.drawPath(poly([(x / GLOW_SCALE, y / GLOW_SCALE) for x, y in pts[::3]], True), gp)

    def interference(self, c, g, t, a):
        """Two sources, two sets of waves: precision as a pattern of agreement."""
        if a <= 0:
            return
        e = self.energy(t)
        sep = 260 + 60 * math.sin(t * 0.07)
        for sx, rgb in ((CX - sep, TIDE), (CX + sep, BRASS)):
            phase = (t * 38) % 60
            for k in range(26):
                r = phase + k * 60
                fade = a * clamp(1 - r / 1500) * 0.55
                if fade <= 0.01:
                    continue
                c.drawCircle(sx, CY, r, stroke(rgb, fade, 1.4))
            radial(g, sx / GLOW_SCALE, CY / GLOW_SCALE, 34 + 20 * e, rgb, 0.7 * a)
            c.drawCircle(sx, CY, 4, fill(PAPER, a))

    def lattice_layer(self, c, g, t, a, spread=1.0, compass=0.0):
        """A rotating crystal lattice: the standard kilogram's silicon, a nation of points."""
        if a <= 0:
            return
        e = self.energy(t)
        ry, rx = t * 0.11, 0.42 + 0.12 * math.sin(t * 0.05)
        cy_, sy_, cx_, sx_ = math.cos(ry), math.sin(ry), math.cos(rx), math.sin(rx)
        pts = self.lattice * 120 * spread
        x = pts[:, 0] * cy_ + pts[:, 2] * sy_
        z = -pts[:, 0] * sy_ + pts[:, 2] * cy_
        y = pts[:, 1] * cx_ - z * sx_
        z = pts[:, 1] * sx_ + z * cx_
        persp = 1400 / (1400 + z + 600)
        px, py = CX + x * persp, CY + y * persp
        lines = []
        g_idx = {tuple(p): i for i, p in enumerate(self.lattice.astype(int))}
        for i, p in enumerate(self.lattice.astype(int)):
            for d in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
                j = g_idx.get((p[0] + d[0], p[1] + d[1], p[2] + d[2]))
                if j is not None:
                    lines.extend((skia.Point(px[i], py[i]), skia.Point(px[j], py[j])))
        c.drawPoints(skia.Canvas.kLines_PointMode, lines, stroke(TIDE, a * 0.13, 1))
        order = np.argsort(-z)
        near = [skia.Point(px[i], py[i]) for i in order if persp[i] > 0.75]
        far = [skia.Point(px[i], py[i]) for i in order if persp[i] <= 0.75]
        c.drawPoints(skia.Canvas.kPoints_PointMode, far, stroke(PAPER, a * 0.45, 3))
        c.drawPoints(skia.Canvas.kPoints_PointMode, near, stroke(BRASS, a * 0.9, 5.5))
        gp = additive(stroke(BRASS, a * 0.5 * (0.5 + e), 4))
        gp.setMaskFilter(self.blur[2])
        g.drawPoints(skia.Canvas.kPoints_PointMode,
                     [skia.Point(p.x() / GLOW_SCALE, p.y() / GLOW_SCALE) for p in near], gp)
        if compass > 0:
            # the compass needle sweeping for its bearing: "方向"
            ang = math.radians(-90 + 140 * math.sin(t * 0.21) * (1 - 0.6 * compass))
            r = 470
            tip = (CX + r * math.cos(ang), CY + r * math.sin(ang))
            c.drawLine(CX, CY, *tip, stroke(VERMILION, compass * a * 0.8, 2))
            arc = skia.Rect.MakeXYWH(CX - r, CY - r, 2 * r, 2 * r)
            c.drawArc(arc, math.degrees(ang) - 18, 18, False, stroke(VERMILION, compass * a * 0.6, 6, skia.Paint.kButt_Cap))

    def converge(self, c, g, t, a, k):
        """All the motes of the film coming home to the centre."""
        if a <= 0:
            return
        pts_far, pts_near = [], []
        for r0, th0, s, ph in self.motes:
            radius = (240 + 900 * r0) * (1 - 0.86 * smooth(k + 0.15 * s - 0.08))
            th = th0 * 6.283 + t * (0.15 + 0.35 * s) * (1 + 3 * k)
            pt = skia.Point(CX + radius * math.cos(th), CY + radius * math.sin(th) * 0.9)
            (pts_near if s > 0.6 else pts_far).append(pt)
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts_far, stroke(PAPER, a * 0.45, 2.2))
        c.drawPoints(skia.Canvas.kPoints_PointMode, pts_near, stroke(BRASS, a * 0.85, 3.6))
        gp = additive(stroke(BRASS, a * 0.4, 3))
        gp.setMaskFilter(self.blur[2])
        g.drawPoints(skia.Canvas.kPoints_PointMode,
                     [skia.Point(p.x() / GLOW_SCALE, p.y() / GLOW_SCALE) for p in pts_near], gp)

    def final_field(self, c, g, t, a, open_k):
        """The stage the CSS continues: a quiet survey grid, a wide ring, a held glow."""
        if a <= 0:
            return
        step = 96
        grid = []
        for x in range(0, W + 1, step):
            grid.extend((skia.Point(x, 0), skia.Point(x, H)))
        for y in range(-12, H + 1, step):
            grid.extend((skia.Point(0, y), skia.Point(W, y)))
        c.drawPoints(skia.Canvas.kLines_PointMode, grid, stroke(BRASS, a * 0.1, 1, skia.Paint.kButt_Cap))
        # centre glow, kept soft so DOM characters read on top of it
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 150 + 30 * open_k, BRASS, a * 0.32)
        radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 60, VERMILION, a * 0.18)

    # -- frame -----------------------------------------------------------
    def frame(self, t):
        cu = CUES
        c = self.surface.getCanvas()
        g = self.glow.getCanvas()
        g.clear(skia.ColorTRANSPARENT)
        self.background(c, t)
        e = self.energy(t)

        # I. Ignition and the dial (prelude)
        a_point = window(t, cu["intro_in"] + 0.8, cu["verse1"] - 2, 2.0, 3.0)
        self.reference_point(c, g, t, a_point)
        dial_build = ease_out((t - cu["prelude"]) / 12)
        a_dial = window(t, cu["prelude"], cu["verse1"] - 1, 0.8, 3.5)
        swing = 38 * math.sin((t - cu["prelude"]) * 1.25) * math.exp(-(t - cu["prelude"]) / 14)
        self.dial(c, g, t, a_dial, 300 + 40 * dial_build, dial_build, -8 * (t - cu["prelude"]), swing)

        # II. The tide (verse one)
        self.tide(c, g, t, window(t, cu["verse1"], cu["spring"] + 3, 3.0, 5.0))

        # III. Spring lights over the fields
        a_seed = window(t, cu["spring"], cu["nation"] + 2, 3.0, 4.0)
        self.seeds_layer(c, g, t, a_seed)

        # IV. The nation's grid and the dawn
        a_grid = window(t, cu["spring"] + 8, cu["interlude"] + 2, 6.0, 5.0)
        lift = smooth((t - cu["interlude"] + 4) / 10)
        dawn = smooth((t - cu["nation"]) / 12) * (1 - smooth((t - cu["interlude"]) / 6))
        self.field_grid(c, g, t, a_grid, lift, dawn)

        # V. Interlude: the astrolabe under the stars
        a_stars = window(t, cu["interlude"] - 3, cu["converge"] + 4, 4.0, 6.0)
        self.stars_layer(c, t, a_stars * 0.9)
        self.astrolabe(c, g, t, window(t, cu["interlude"], cu["verse2"] + 1, 3.0, 4.0))

        # VI. Verse two: interference
        self.interference(c, g, t, window(t, cu["verse2"], cu["lattice"], 3.0, 4.0))

        # VII. The lattice and the compass
        a_lat = window(t, cu["lattice"], cu["converge"] + 2, 3.0, 5.0)
        compass = window(t, cu["lattice"] + 14, cu["converge"] - 4, 4.0, 4.0)
        self.lattice_layer(c, g, t, a_lat, 1.0 - 0.35 * smooth((t - cu["converge"] + 4) / 8), compass)

        # VIII. Convergence on the centre
        k = clamp((t - cu["converge"]) / (cu["ji"] - cu["converge"]))
        a_conv = window(t, cu["converge"], cu["ji"] + 1.2, 3.0, 1.4)
        self.converge(c, g, t, a_conv, k)
        rebuild = ease_out((t - cu["converge"] - 6) / (cu["ji"] - cu["converge"] - 6))

        # IX. 计: the needle sweeps and locks; X. 量: the ring opens across the frame
        ji_k = clamp((t - cu["ji"]) / (cu["liang"] - cu["ji"]))
        liang_k = ease_out((t - cu["liang"]) / (cu["sung_end"] - cu["liang"]))
        a_final_dial = window(t, cu["converge"] + 6, self.duration + 10, 4.0, 0.1)
        if a_final_dial > 0:
            needle = None
            locked = 0.0
            if t >= cu["ji"] - 2:
                # wander, then a damped swing that settles exactly on zero as 量 arrives
                sweep_from = -150
                needle = sweep_from * (1 - smooth(ji_k)) + 6 * math.sin(ji_k * 14) * (1 - ji_k)
                locked = smooth((t - cu["liang"] + 0.3) / 0.6)
            radius = 300 + 240 * liang_k
            self.dial(c, g, t, a_final_dial * (1 - 0.45 * liang_k), radius, rebuild, -90 * (1 - rebuild),
                      needle, BRASS, glow=1 + 1.5 * locked * (1 - liang_k) + 0.4 * e, locked=locked,
                      # its work done, the needle leaves the centre clear for the characters
                      needle_a=1 - smooth((t - cu["liang"] - 0.8) / 2.6))
            if t >= cu["liang"] - 0.2:
                # the flash of agreement, then rings carried outward
                flash = math.exp(-max(0.0, t - cu["liang"]) / 0.9) * smooth((t - cu["liang"] + 0.2) / 0.25)
                radial(g, CX / GLOW_SCALE, CY / GLOW_SCALE, 220, PAPER, 0.55 * flash)
                for n in range(4):
                    rk = ease_out((t - cu["liang"] - n * 0.45) / 4.5)
                    if 0 < rk < 1:
                        c.drawCircle(CX, CY, 300 + rk * 900, stroke(PAPER if n % 2 else BRASS, (1 - rk) * 0.6, 1.6))
        a_final = smooth((t - cu["liang"] + 0.5) / 3.0)
        self.final_field(c, g, t, a_final, liang_k)

        # vignette keeps the edges dark for the CSS layer to blend into
        vig = skia.GradientShader.MakeRadial(
            center=(CX, CY), radius=W * 0.62,
            colors=[color(NIGHT, 0), color(NIGHT, 0), color(NIGHT, 0.72)], positions=[0, 0.55, 1])
        c.drawPaint(skia.Paint(Shader=vig))

        # glow layer back on top, additively
        glow_img = self.glow.makeImageSnapshot()
        gp = skia.Paint()
        gp.setBlendMode(skia.BlendMode.kPlus)
        c.drawImageRect(glow_img, skia.Rect.MakeWH(W, H), skia.SamplingOptions(skia.FilterMode.kLinear), gp)
        # fade from and to nothing at the very start
        if t < cu["intro_in"] + 0.8:
            c.drawPaint(fill(NIGHT, 1 - smooth((t - cu["intro_in"]) / 0.8)))
        return self.surface.makeImageSnapshot().tobytes()


# ---------------------------------------------------------------- render
def render_range(args):
    audio, duration, start, end, out = args
    env = loudness_envelope(audio, duration)
    scene = Scene(env, duration)
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "12",
         "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i in range(start, end):
        enc.stdin.write(scene.frame(i / FPS))
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
        scene = Scene(loudness_envelope(opts.audio, duration), duration)
        for t in opts.preview:
            img = skia.Image.frombytes(scene.frame(t), skia.ISize(W, H), skia.kBGRA_8888_ColorType)
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
        # the last frame, for the final stage's base layer before the video is decoded
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.1", "-i", master, "-frames:v", "1",
                        "-q:v", "3", os.path.join(opts.out_dir, "easteregg-final.jpg")], check=True)
    print(json.dumps({"duration": duration, "frames": frames, "fps": FPS, "cues": CUES}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
