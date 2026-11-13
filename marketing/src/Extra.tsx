import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, type Deal, EndCard, Fonts, Glass, SANS, SERIF } from "./Ad";

const hit = (f: number, at: number, fps: number, stiff = 220, damp = 16) =>
  spring({ frame: f - at, fps, config: { stiffness: stiff, damping: damp, mass: 0.6 } });

/* ---------- Founder clip: a talking head, branded, with an end card ---------- */
export interface FounderProps { video: string; seconds: number; name?: string | null; deal?: Deal | null }

/** The week's deal pops up over the talking head, a third of the way in, for about 5 seconds. */
const DealPop: React.FC<{ deal: Deal; at: number; until: number }> = ({ deal, at, until }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (f < at || f >= until) return null;
  const s = hit(f, at, fps, 280, 15);
  const out = interpolate(f, [until - 10, until], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 60, right: 60, bottom: 520, opacity: s * (1 - out), transform: `scale(${0.85 + 0.15 * s}) translateY(${out * 40}px)` }}>
      <Glass style={{ padding: "30px 40px", borderRadius: 36 }}>
        <div style={{ fontFamily: SANS, fontSize: 26, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: C.fg2 }}>This week's deal</div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 20, marginTop: 8 }}>
          <div style={{ fontFamily: SERIF, fontSize: 64, color: C.fg, lineHeight: 1.05 }}>{deal.from} → {deal.to}</div>
          <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 96, color: C.accent, letterSpacing: "-.03em" }}>${deal.price}</div>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 500, color: C.fg2, marginTop: 6 }}>round trip · {deal.dates}{deal.usual ? ` · usually $${deal.usual}` : ""}</div>
      </Glass>
    </div>
  );
};

export const Founder: React.FC<FounderProps> = ({ video, seconds, name, deal }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const talkEnd = Math.round(seconds * fps);
  const lower = hit(f, 18, fps);
  const lowerOut = interpolate(f, [fps * 5, fps * 5.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const toEnd = interpolate(f, [talkEnd - 8, talkEnd + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const popAt = Math.max(Math.round(fps * 6), Math.round(talkEnd * 0.35));
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Fonts />
      <AbsoluteFill style={{ filter: `blur(${toEnd * 24}px) brightness(${1 - toEnd * 0.45})` }}>
        <OffthreadVideo src={staticFile(video)} endAt={talkEnd} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      {/* small wordmark, top left */}
      <div style={{ position: "absolute", top: 90, left: 60, opacity: 1 - toEnd }}>
        <Glass style={{ padding: "16px 28px", borderRadius: 999 }}>
          <span style={{ fontFamily: SERIF, fontSize: 44, color: C.fg }}>Fare Radar</span>
        </Glass>
      </div>
      {name ? (
        <div style={{ position: "absolute", left: 60, bottom: 300, opacity: lower * (1 - lowerOut), transform: `translateY(${(1 - lower) * 30}px)` }}>
          <Glass style={{ padding: "22px 34px", borderRadius: 28 }}>
            <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 44, color: C.fg }}>{name}</div>
            <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 30, color: C.accent, marginTop: 4 }}>Co-founder, Fare Radar</div>
          </Glass>
        </div>
      ) : null}
      {deal && talkEnd - popAt > fps * 3 ? <DealPop deal={deal} at={popAt} until={Math.min(talkEnd - 6, popAt + fps * 5)} /> : null}
      {f >= talkEnd ? <EndCard at={talkEnd} /> : null}
    </AbsoluteFill>
  );
};

/* ---------- Top five: the week's five cheapest places, one per beat phrase ---------- */
export interface TopFiveProps { beats: number[]; audio: string; deals: Deal[]; photo?: string | null }

export const TopFive: React.FC<TopFiveProps> = ({ beats, audio, deals, photo }) => {
  const f = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const b = (i: number) => Math.round((beats[Math.min(i, beats.length - 1)] ?? i * 0.43) * fps);
  const five = deals.slice(0, 5);
  const starts = five.map((_, i) => b(8 + i * 4));
  const cur = starts.filter((s) => f >= s).length - 1;
  // Small hit only when a new card lands.
  const land = starts.find((s) => f - s >= 0 && f - s < 8);
  const pulse = land === undefined ? 1 : 1 + 0.012 * (1 - (f - land) / 8);
  const t1 = hit(f, b(0), fps, 220, 18), t2 = hit(f, b(2), fps, 220, 18), t3 = hit(f, b(4), fps, 220, 18);
  const titleOut = interpolate(f, [b(7), b(8)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tall = height > 1500;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Fonts />
      <Audio src={staticFile(audio)} />
      <Img src={staticFile(photo || "bg.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover",
        transform: `scale(${interpolate(f, [0, 450], [1.12, 1]) * pulse})`, filter: `blur(${f < b(8) ? 16 : 8}px) brightness(.58)` }} />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(8,18,22,.5), rgba(8,18,22,.15) 40%, rgba(8,18,22,.7))" }} />
      {f < b(8) ? (
        <AbsoluteFill style={{ justifyContent: "center", padding: "0 90px", opacity: titleOut }}>
          <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: tall ? 260 : 200, color: C.accent, lineHeight: .9, opacity: t1, transform: `scale(${0.8 + 0.2 * t1})`, transformOrigin: "left" }}>5</div>
          <div style={{ fontFamily: SERIF, fontSize: tall ? 120 : 96, color: C.fg, lineHeight: 1.02, opacity: t2, transform: `translateY(${(1 - t2) * 30}px)` }}>cheap flights<br /><span style={{ fontStyle: "italic", color: C.fg2 }}>this week.</span></div>
          <div style={{ fontFamily: SANS, fontSize: 48, fontWeight: 600, color: C.fg2, marginTop: 30, opacity: t3 }}>Out of Seattle &amp; Portland. Round trip.</div>
        </AbsoluteFill>
      ) : null}
      {cur >= 0 && f < b(29) ? (() => {
        const d = five[cur];
        const s = hit(f, starts[cur], fps, 300, 16);
        return (
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `scale(${pulse})` }}>
            <div style={{ position: "absolute", top: tall ? 220 : 70, fontFamily: SANS, fontWeight: 800, fontSize: 40, color: C.fg2, letterSpacing: ".1em" }}>{cur + 1} / {five.length}</div>
            <Glass style={{ width: 880, padding: "56px 60px", transform: `scale(${interpolate(s, [0, 1], [1.3, 1])})`, opacity: Math.min(1, s * 1.4) }}>
              <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: C.fg2 }}>From {d.from}</div>
              <div style={{ fontFamily: SERIF, fontSize: d.to.length > 14 ? 76 : 96, color: C.fg, marginTop: 10, lineHeight: 1 }}>{d.to}</div>
              <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 190, color: C.accent, letterSpacing: "-.04em", lineHeight: .95, marginTop: 20 }}>${d.price}</div>
              <div style={{ fontFamily: SANS, fontSize: 36, fontWeight: 500, color: C.fg2, marginTop: 16 }}>{d.dates}{d.usual ? ` · usually $${d.usual}` : ""}</div>
            </Glass>
          </AbsoluteFill>
        );
      })() : null}
      {f >= b(29) ? <EndCard at={b(29)} /> : null}
    </AbsoluteFill>
  );
};

/* ---------- Trip edit: your trip clips cut on the beat, then a real deal ---------- */
export interface TripProps { beats: number[]; audio: string; clips: string[]; photos: string[]; deal: Deal; caption: string }

export const Trip: React.FC<TripProps> = ({ beats, audio, clips, photos, deal, caption }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const b = (i: number) => Math.round((beats[Math.min(i, beats.length - 1)] ?? i * 0.43) * fps);
  const media = [...clips.map((c) => ({ kind: "video" as const, src: c })), ...photos.map((p) => ({ kind: "photo" as const, src: p }))];
  // A new shot every 2 beats up to beat 16, then the deal card, then the end card.
  const shotIdx = Math.min(7, Math.floor([0, 2, 4, 6, 8, 10, 12, 14].filter((i) => f >= b(i)).length - 1));
  const shot = media.length ? media[Math.max(0, shotIdx) % media.length] : null;
  const shotStart = b(Math.max(0, shotIdx) * 2);
  const zoom = interpolate(f - shotStart, [0, fps * 2], [1.08, 1.0], { extrapolateRight: "clamp" });
  const cap = hit(f, b(1), fps, 200, 18);
  const card = hit(f, b(16), fps, 300, 16);
  const dim = interpolate(f, [b(15), b(16)], [0.62, 0.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Fonts />
      <Audio src={staticFile(audio)} />
      {shot ? (
        <AbsoluteFill style={{ transform: `scale(${zoom})`, filter: `brightness(${dim + 0.25})` }}>
          {shot.kind === "video"
            ? <OffthreadVideo key={shot.src + shotIdx} src={staticFile(shot.src)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <Img src={staticFile(shot.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        </AbsoluteFill>
      ) : <Img src={staticFile("bg.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(.55)" }} />}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(8,18,22,.45), rgba(8,18,22,0) 35%, rgba(8,18,22,.6))" }} />
      {f < b(16) ? (
        <AbsoluteFill style={{ justifyContent: "flex-end", padding: "0 80px 340px" }}>
          <div style={{ fontFamily: SERIF, fontSize: 120, color: C.fg, lineHeight: 1.02, opacity: cap, transform: `translateY(${(1 - cap) * 30}px)` }}>{caption}</div>
        </AbsoluteFill>
      ) : null}
      {f >= b(16) && f < b(29) ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Glass style={{ width: 880, padding: "56px 60px", transform: `scale(${interpolate(card, [0, 1], [1.3, 1])})`, opacity: Math.min(1, card * 1.4) }}>
            <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: C.fg2 }}>Found this week</div>
            <div style={{ fontFamily: SERIF, fontSize: 84, color: C.fg, marginTop: 12, lineHeight: 1 }}>{deal.from} → {deal.to}</div>
            <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 190, color: C.accent, letterSpacing: "-.04em", lineHeight: .95, marginTop: 20 }}>${deal.price}</div>
            <div style={{ fontFamily: SANS, fontSize: 36, fontWeight: 500, color: C.fg2, marginTop: 18 }}>round trip · {deal.dates}</div>
          </Glass>
        </AbsoluteFill>
      ) : null}
      {f >= b(29) ? <EndCard at={b(29)} /> : null}
    </AbsoluteFill>
  );
};
