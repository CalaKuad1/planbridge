# Renders the PlanBridge README demo frame by frame from REAL recorded output.
#   python render.py <recording.json> <out_dir>
import json, os, re, sys
from PIL import Image, ImageDraw, ImageFont

REC = json.load(open(sys.argv[1], encoding="utf-8"))
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)

W, H, FPS = 960, 540, 15
F = r"C:\Windows\Fonts"
mono = ImageFont.truetype(os.path.join(F, "CascadiaMono.ttf"), 15)
mono_b = ImageFont.truetype(os.path.join(F, "CascadiaMono.ttf"), 15)
sym = ImageFont.truetype(os.path.join(F, "seguisym.ttf"), 14)
ui = ImageFont.truetype(os.path.join(F, "segoeui.ttf"), 13)
ui_b = ImageFont.truetype(os.path.join(F, "segoeuib.ttf"), 13)
big = ImageFont.truetype(os.path.join(F, "segoeuib.ttf"), 54)
mid = ImageFont.truetype(os.path.join(F, "segoeui.ttf"), 22)
CW = mono.getlength("M")
LH = 22

C = dict(
    page="#15120f", win="#211e1b", bar="#2c2824", line="#3a3530",
    ink="#ece7df", dim="#8d867c", accent="#e07a56", green="#8fcf9c",
    str="#e3c07a", kw="#c99be0", fn="#7fb8e6", num="#e89a7a", panel="#1b1916", track="#5b544b",
)

def lerp(a, b, t): return a + (b - a) * max(0, min(1, t))

def text(d, x, y, s, color=C["ink"], font=mono):
    """Monospace text with a symbol-font fallback for glyphs Cascadia lacks."""
    for ch in s:
        if ch in "✔✘":
            d.text((x, y - 2), ch, font=sym, fill=color)
        else:
            d.text((x, y), ch, font=font, fill=color)
        x += CW
    return x

def segs(d, x, y, parts):
    for s, col in parts:
        x = text(d, x, y, s, col)
    return x

def window(img, title, box):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, 12, fill=C["win"], outline=C["line"])
    d.rounded_rectangle((x0, y0, x1, y0 + 34), 12, fill=C["bar"])
    d.rectangle((x0, y0 + 22, x1, y0 + 34), fill=C["bar"])
    for i, col in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        cx = x0 + 20 + i * 20
        d.ellipse((cx - 6, y0 + 11, cx + 6, y0 + 23), fill=col)
    tw = d.textlength(title, font=ui)
    d.text(((x0 + x1 - tw) / 2, y0 + 9), title, font=ui, fill=C["dim"])
    return d

def cursor_on(t): return (t // 530) % 2 == 0

def typed(cmd, t, start, per=42):
    n = int((t - start) // per) if t >= start else 0
    return cmd[: max(0, min(len(cmd), n))], start + per * len(cmd)

def prompt_line(d, x, y, cmd, t, start, show_cursor=True, per=42):
    shown, end = typed(cmd, t, start, per)
    x = segs(d, x, y, [("~ ", C["green"]), ("$ ", C["dim"]), (shown, C["ink"])])
    if show_cursor and (t < end + 250 and (cursor_on(t) or t < end)):
        d.rectangle((x + 1, y + 3, x + CW - 1, y + LH - 3), fill=C["ink"])
    return end

# ------------------------------------------------------------ scene timings (ms)
S1, S2, S3, S4, END = 0, 4300, 11300, 15000, 17200
REC_T0 = S2 + 1250            # moment "node haiku.mjs" + Enter happens
OUTPUT_END = REC_T0 + REC[-1]["t"]

BANNER = [
    [("", None)],
    [("  PlanBridge v1.2.0", C["ink"]), (" — your Claude Code subscription as a local API", C["dim"])],
    [("", None)],
    [("  Playground   ", C["dim"]), ("http://127.0.0.1:3456/", C["accent"])],
    [("  OpenAI       ", C["dim"]), ("http://127.0.0.1:3456/v1", C["accent"]), ("   (chat/completions)", C["dim"])],
    [("  Anthropic    ", C["dim"]), ("http://127.0.0.1:3456", C["accent"]), ("      (v1/messages)", C["dim"])],
    [("  API key      ", C["dim"]), ("pb-" + "•" * 16, C["ink"])],
    [("  Model        ", C["dim"]), ("sonnet · 2 parallel · 30/min", C["ink"])],
]

CODE = open(os.path.join(os.path.dirname(sys.argv[1]), "haiku.mjs"), encoding="utf-8").read().rstrip("\n").split("\n")
TOK = re.compile(r"('[^']*')|\b(import|from|const|await|new|for|of|true)\b|(\w+)(?=\()|(\d[\d.]*)|(.)")

def code_line(d, x, y, line):
    for m in TOK.finditer(line):
        s, kw, fn, num, other = m.groups()
        if s: col = C["accent"] if "127.0.0.1" in s else C["str"]
        elif kw: col = C["kw"]
        elif fn: col = C["fn"]
        elif num: col = C["num"]
        else: col = C["ink"]
        text(d, x, y, m.group(0), col)
        x += CW * len(m.group(0))

STATUS = [
    [("  ", C["ink"]), ("✔", C["green"]), (" Running at http://127.0.0.1:3456  ", C["ink"]), ("v1.2.0 · model sonnet · 0 active, 0 queued", C["dim"])],
    [("    five_hour  ", C["ink"]), ("█" * 5, C["accent"]), ("░" * 15, C["track"]), (" 24%  ", C["ink"]), ("resets 1/11/2026, 4:20:00", C["dim"])],
    [("    seven_day  ", C["ink"]), ("█" * 3, C["accent"]), ("░" * 17, C["track"]), (" 17%  ", C["ink"]), ("resets 5/11/2026, 6:00:00", C["dim"])],
]

def frame(t):
    img = Image.new("RGB", (W, H), C["page"])
    box = (28, 24, W - 28, H - 24)
    X, Y = box[0] + 22, box[1] + 52

    if t < S2:  # ---------------------------------------------- install & start
        d = window(img, "Terminal", box)
        end = prompt_line(d, X, Y, "npx planbridge start", t, 300)
        for i, parts in enumerate(BANNER):
            if t >= end + 350 + i * 70:
                segs(d, X, Y + LH * (i + 1), [(s, c) for s, c in parts if c])
    elif t < S3:  # -------------------------------------------- the OpenAI SDK
        d = window(img, "Any OpenAI SDK, pointed at localhost", box)
        mid_x = box[0] + 622
        d.line((mid_x, box[1] + 34, mid_x, box[3] - 1), fill=C["line"])
        d.text((X, box[1] + 44), "haiku.mjs", font=ui_b, fill=C["dim"])
        for i, line in enumerate(CODE):
            text(d, X - 4, Y + 18 + i * 20, f"{i + 1:>2}", C["line"])
            code_line(d, X + 24, Y + 18 + i * 20, line)
        TX, TY = mid_x + 20, Y + 18
        prompt_line(d, TX, TY, "node haiku.mjs", t, S2 + 500, show_cursor=t < REC_T0)
        if t >= REC_T0:
            out = "".join(c["d"] for c in REC if REC_T0 + c["t"] <= t)
            lines = out.split("\n")
            for i, ln in enumerate(lines):
                text(d, TX, TY + LH * (i + 1.4), ln, C["ink"])
            if not out and cursor_on(t):
                d.rectangle((TX, TY + LH * 1.4 + 3, TX + CW - 2, TY + LH * 2.4 - 3), fill=C["dim"])
            if t >= OUTPUT_END + 500:
                notes = ["real run, not a mock-up", f"first text after {REC[0]['t'] / 1000:.1f} s", "(incl. Node + SDK start-up)"]
                for k, note in enumerate(notes):
                    text(d, TX, TY + LH * (6 + k), note, C["dim"])
    elif t < S4:  # -------------------------------------------- plan usage
        d = window(img, "Terminal", box)
        end = prompt_line(d, X, Y, "planbridge status", t, S3 + 300)
        for i, parts in enumerate(STATUS):
            if t >= end + 350 + i * 90:
                segs(d, X, Y + LH * (i + 1.4), [(s, c) for s, c in parts if c])
    else:  # ---------------------------------------------------- end card
        d = ImageDraw.Draw(img)
        a = lerp(0, 1, (t - S4) / 400)
        def fade(hexcol):
            r, g, b = (int(hexcol[i:i + 2], 16) for i in (1, 3, 5))
            pr, pg, pb = (int(C["page"][i:i + 2], 16) for i in (1, 3, 5))
            return (int(lerp(pr, r, a)), int(lerp(pg, g, a)), int(lerp(pb, b, a)))
        title = "PlanBridge"
        tw = d.textlength("Plan", font=big)
        tw2 = d.textlength(title, font=big)
        x = (W - tw2) / 2
        d.text((x, 168), "Plan", font=big, fill=fade(C["ink"]))
        d.text((x + tw, 168), "Bridge", font=big, fill=fade(C["accent"]))
        sub = "Your Claude Code subscription as a local API for your own apps"
        d.text(((W - d.textlength(sub, font=mid)) / 2, 250), sub, font=mid, fill=fade(C["dim"]))
        cmd = "npm i -g planbridge"
        cw = CW * len(cmd) + 36
        bx = (W - cw) / 2
        d.rounded_rectangle((bx, 312, bx + cw, 350), 8, fill=fade(C["bar"]), outline=fade(C["line"]))
        text(d, bx + 18, 320, cmd, fade(C["ink"]))
        foot = "OpenAI & Anthropic compatible · images · PDFs · sessions · JSON · zero dependencies"
        d.text(((W - d.textlength(foot, font=ui)) / 2, 380), foot, font=ui, fill=fade(C["dim"]))
    return img

n = int(END / 1000 * FPS)
for i in range(n):
    frame(i * 1000 / FPS).save(os.path.join(OUT, f"f{i:04d}.png"))
print("frames:", n)
