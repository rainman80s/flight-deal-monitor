# Weekly social content

Owners drop media into **Admin → Content** on the site (talking heads, trip photos, trip videos,
licensed music). Once a week `weekly.mjs` builds that week's posts from the live deals plus that
media and uploads them, with captions, to **Ready to post**.

```bash
cd marketing && npm ci && pip install librosa
node weekly.mjs --dry-run   # build into marketing/out only
node weekly.mjs             # build and upload to Ready to post
```

Posts each week:
1. **Deal Drop** (`[REEL] flightdeal<city>9x16.mp4`, `[POST] flightdeal<city>4x4.mp4`): 15-second beat-synced ad of the week's best real fare (vertical + square). Trip
   photos become the background and trip clips play behind the intro.
2. **Trip edit**: your trip clips and photos cut on the beat, then a real deal and the end card
   (when the library has trip media).
3. **Top five** (`[REEL]`/`[POST] topfivedeals`): the week's five cheapest places, one per beat phrase. Always made, even with an empty library.
4. **Founder clip**: the oldest unused talking head, trimmed to 58 seconds, branded, with the end
   card.

Media is used once before it repeats (tracked in `system/used.json` in the bucket). Beats rotate,
least recently used first. `beat.py` finds each beat's tempo and drop so cuts land on the beat.
Only put **licensed** music in the library, with its license PDF.

Before anything uploads, every video is checked (size, length, sound, real picture at start, middle and end) and every text file is checked for blanks or placeholders. One failure stops the whole batch; the plan file goes up last, and a failed upload removes whatever already went up. A week is delivered complete or not at all.
