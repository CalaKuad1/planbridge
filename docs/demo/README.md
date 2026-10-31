# Demo GIF

`demo.gif` is drawn frame by frame from a **real** run, not a mock-up:

1. `haiku.mjs` is the exact script shown in the GIF. `stamp.mjs` runs it against a live PlanBridge and records every stdout chunk with its timestamp in `recording.json`.
2. `render.py` (Pillow, Windows fonts Cascadia Mono / Segoe UI) replays that recording at its real speed. The banner and `planbridge status` lines are the real CLI output. Only the API key is masked.

```bash
PLANBRIDGE_API_KEY=$(planbridge key) node stamp.mjs haiku.mjs     # needs `npm i openai`
python render.py recording.json frames
ffmpeg -framerate 15 -i frames/f%04d.png -vf "palettegen=max_colors=96:stats_mode=diff" palette.png
ffmpeg -framerate 15 -i frames/f%04d.png -i palette.png -lavfi "paletteuse=dither=none:diff_mode=rectangle" -loop 0 ../demo.gif
```
