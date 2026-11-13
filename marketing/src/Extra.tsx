import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, type Deal, EndCard, Fonts, Glass, SANS, SERIF } from "./Ad";

const hit = (f: number, at: number, fps: number, stiff = 220, damp = 16) =>
  spring({ frame: f - at, fps, config: { stiffness: stiff, damping: damp, mass: 0.6 } });

/* ---------- Founder clip: a talking head, branded, with an end card ---------- */
export interface FounderProps { video: string; seconds: number; name?: string | null }

export const Founder: React.FC<FounderProps> = ({ video, seconds, name }) => {
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const talkEnd = Math.round(seconds * fps);
  const lower = hit(f, 18, fps);
  const lowerOut = interpolate(f, [fps * 5, fps * 5.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const toEnd = interpolate(f, [talkEnd - 8, talkEnd + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
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
      {f >= talkEnd ? <EndCard at={talkEnd} /> : null}
      {f < durationInFrames ? null : null}
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
