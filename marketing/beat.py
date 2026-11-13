"""Find the beat grid and the drop in a track, and pick a 15-second cut that starts 8 beats before it.

Usage: python3 -I beat.py track.mp3  ->  prints JSON {tempo, start, beats: [...seconds from start], drop}
"""
import json
import sys

import librosa
import numpy as np

path = sys.argv[1]
y, sr = librosa.load(path, sr=22050, mono=True, duration=180)
tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
beats = librosa.frames_to_time(frames, sr=sr)
rms = librosa.feature.rms(y=y)[0]
t = librosa.times_like(rms, sr=sr)

# Loudness per 4-beat bar; the drop is the first bar that jumps well above everything before it.
bars = []
for i in range(0, len(beats) - 4, 4):
    m = rms[(t >= beats[i]) & (t < beats[i + 4])]
    bars.append((i, float(m.mean()) if len(m) else 0.0))
drop_beat = None
for j in range(2, len(bars)):
    before = np.median([v for _, v in bars[:j]])
    if bars[j][1] > 2.2 * max(before, 1e-4):
        drop_beat = bars[j][0]
        break
if drop_beat is None:  # no clear drop: use the biggest bar-to-bar rise
    rises = [(bars[j][1] - bars[j - 1][1], bars[j][0]) for j in range(1, len(bars))]
    drop_beat = max(rises)[1] if rises else 8
drop_beat = max(8, drop_beat)
start_i = drop_beat - 8
start = float(beats[start_i])
grid = [round(float(b) - start, 3) for b in beats[start_i:start_i + 36]]
print(json.dumps({"tempo": round(float(np.atleast_1d(tempo)[0]), 1), "start": round(start, 3),
                  "drop": round(float(beats[drop_beat]), 3), "beats": grid}))
