import React from "react";
import {
  AbsoluteFill, Audio, Easing, Img, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";

/**
 * "Deal Drop": a 15-second, beat-synced ad built from the week's real fares.
 * Everything that changes week to week comes in as props (see weekly.mjs):
 *   beats   – beat times in seconds from the start of the audio cut; beat 8 is the drop
 *   audio   – the cut of a licensed beat, in public/
 *   hero, list, alert – real deals from the live site
 *   photo   – optional trip photo for the background (public/), else the site's mountain photo
 *   clips   – optional trip video clips (public/) that play behind the intro words
 */
export interface Deal { from: string; to: string; price: number; usual?: number | null; dates: string; airline?: string; origin?: string }
export interface AdProps {
  beats: number[];
  audio: string;
  hero: Deal;
  list: Deal[];
  alert: Deal;
  photo?: string | null;
  clips?: string[];
  month: string;
}

export const DEFAULT_PROPS: AdProps = {
  beats: [0, 0.418, 0.859, 1.3, 1.718, 2.16, 2.578, 2.995, 3.413, 3.855, 4.273, 4.691, 5.132, 5.573, 5.991, 6.432,
    6.85, 7.291, 7.709, 8.127, 8.568, 8.986, 9.427, 9.845, 10.263, 10.704, 11.146, 11.564, 11.982, 12.423, 12.841,
    13.282, 13.7, 14.141, 14.559],
  audio: "cut.mp3",
  hero: { from: "Seattle", to: "Los Angeles", price: 85, usual: 151, dates: "Dec 7 → Dec 14", airline: "Frontier" },
  list: [
    { from: "SEA", to: "Las Vegas", price: 93, dates: "" }, { from: "SEA", to: "Denver", price: 138, dates: "" },
    { from: "PDX", to: "Salt Lake City", price: 151, dates: "" }, { from: "PDX", to: "Tampa", price: 181, dates: "" },
    { from: "SEA", to: "Phoenix", price: 186, dates: "" },
  ],
  alert: { from: "Seattle", to: "Cabo", price: 435, dates: "Jan 29 → Feb 4", airline: "Alaska · Nonstop" },
  photo: null,
  clips: [],
  month: "Nov 2026",
};

const DROP = 8;
const C = {
  bg: "#0e1d22", fg: "#f5f7f4", fg2: "rgba(236,242,238,.78)", accent: "#f6b443", ink: "#1b1406",
  ok: "#5ad48a", glass: "rgba(16,32,38,.46)", rim: "rgba(255,255,255,.24)",
};
const SERIF = "InstrumentSerif, Georgia, serif";
const SANS = "Inter, system-ui, sans-serif";

const Ctx = React.createContext<AdProps>(DEFAULT_PROPS);
const useProps = () => React.useContext(Ctx);
/** Frame of beat i (clamped to the last known beat, so short beat lists still render). */
const useB = () => {
  const { beats } = useProps();
  const { fps } = useVideoConfig();
  return (i: number) => Math.round((beats[Math.min(i, beats.length - 1)] ?? i * 0.43) * fps);
};

const Fonts: React.FC = () => (
  <style>{`
    @font-face { font-family: InstrumentSerif; src: url(${staticFile("instrument-serif.woff2")}) format("woff2"); }
    @font-face { font-family: InstrumentSerif; font-style: italic; src: url(${staticFile("instrument-serif-italic.woff2")}) format("woff2"); }
    ${[500, 600, 700, 800].map((w) => `@font-face { font-family: Inter; font-weight: ${w}; src: url(${staticFile(`inter-latin-${w}-normal.woff2`)}) format("woff2"); }`).join("\n")}
  `}</style>
);

const useHit = (at: number, stiff = 220, damp = 14) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - at, fps, config: { stiffness: stiff, damping: damp, mass: 0.6 } });
};

/** A small hit only on beats where something lands on screen; still in between. */
const HITS = [DROP, DROP + 1, DROP + 2, DROP + 3, DROP + 4, 17, 18, 19, 20, 21, 24, 29, 31];
const usePulse = () => {
  const f = useCurrentFrame();
  const b = useB();
  let k = 0;
  for (const i of HITS) {
    const d = f - b(i);
    if (d >= 0 && d < 8) k = Math.max(k, 1 - d / 8);
  }
  return 1 + 0.012 * k;
};

const Glass: React.FC<{ style?: React.CSSProperties; children: React.ReactNode }> = ({ style, children }) => (
  <div style={{
    background: C.glass, border: `1.5px solid ${C.rim}`, borderRadius: 44,
    backdropFilter: "blur(28px) saturate(1.4)", WebkitBackdropFilter: "blur(28px) saturate(1.4)",
    boxShadow: "0 30px 80px rgba(0,0,0,.35), inset 0 1.5px 0 rgba(255,255,255,.25)", ...style,
  }}>{children}</div>
);

const Background: React.FC = () => {
  const f = useCurrentFrame();
  const b = useB();
  const { photo } = useProps();
  const pulse = usePulse();
  const { durationInFrames } = useVideoConfig();
  const zoom = interpolate(f, [0, durationInFrames], [1.12, 1.0]) * pulse;
  const blur = interpolate(f, [0, b(DROP) - 1, b(DROP)], [18, 18, 7], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Img src={staticFile(photo || "bg.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover",
        transform: `scale(${zoom})`, filter: `blur(${blur}px) brightness(.6)` }} />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(8,18,22,.55), rgba(8,18,22,.15) 40%, rgba(8,18,22,.7))" }} />
    </AbsoluteFill>
  );
};

/** Trip clips behind the intro: a new clip on every other beat, slightly darkened. */
const IntroClips: React.FC = () => {
  const f = useCurrentFrame();
  const b = useB();
  const { clips = [] } = useProps();
  if (!clips.length) return null;
  const slot = Math.min(3, Math.floor([0, 2, 4, 6].filter((i) => f >= b(i)).length - 1));
  const clip = clips[Math.max(0, slot) % clips.length];
  const fade = interpolate(f, [b(7), b(DROP)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <OffthreadVideo key={clip} src={staticFile(clip)} muted style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(.55)" }} />
    </AbsoluteFill>
  );
};

const Word: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, children, style }) => {
  const s = useHit(at, 260, 18);
  return <div style={{ opacity: s, transform: `translateY(${(1 - s) * 40}px)`, filter: `blur(${(1 - s) * 10}px)`, ...style }}>{children}</div>;
};

const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const b = useB();
  const { hero } = useProps();
  const { height } = useVideoConfig();
  const out = interpolate(f, [b(7), b(DROP)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 90px", opacity: out }}>
      <div style={{ fontFamily: SERIF, color: C.fg, fontSize: height > 1500 ? 150 : 120, lineHeight: 1.02, letterSpacing: "-.01em" }}>
        <Word at={b(0)}>{hero.from}</Word>
        <Word at={b(2)} style={{ fontStyle: "italic", color: C.fg2 }}>to {hero.to}.</Word>
        {hero.usual ? (
          <Word at={b(4)} style={{ fontFamily: SANS, fontSize: 54, fontWeight: 600, color: C.fg2, marginTop: 40 }}>
            Usually <span style={{ color: C.fg }}>${Math.round(hero.usual)}</span> round trip.
          </Word>
        ) : (
          <Word at={b(4)} style={{ fontFamily: SANS, fontSize: 54, fontWeight: 600, color: C.fg2, marginTop: 40 }}>Round trip.</Word>
        )}
        <Word at={b(6)} style={{ fontFamily: SANS, fontSize: 54, fontWeight: 600, color: C.accent, marginTop: 10 }}>Not this week.</Word>
      </div>
    </AbsoluteFill>
  );
};

const DealCard: React.FC = () => {
  const f = useCurrentFrame();
  const b = useB();
  const { hero } = useProps();
  const { height } = useVideoConfig();
  const land = useHit(b(DROP), 300, 16);
  const top = Math.round(hero.usual && hero.usual > hero.price ? hero.usual : hero.price * 1.6);
  const steps = [top, Math.round(top - (top - hero.price) / 3), Math.round(top - (2 * (top - hero.price)) / 3), hero.price];
  let idx = 0;
  for (let i = 0; i < 4; i++) if (f >= b(DROP + i)) idx = i;
  const tick = f - b(DROP + idx);
  const kick = tick >= 0 && tick < 6 ? 1 + 0.06 * (1 - tick / 6) : 1;
  const pill = useHit(b(DROP + 4), 280, 14);
  const details = useHit(b(DROP + 5), 200, 18);
  const exit = interpolate(f, [b(DROP + 7), b(DROP + 8)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  const pct = hero.usual && hero.usual > hero.price ? Math.round((1 - hero.price / hero.usual) * 100) : null;
  const long = `${hero.from} → ${hero.to}`.length > 22;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Glass style={{ width: height > 1500 ? 900 : 860, padding: "60px 64px", transform: `scale(${interpolate(land, [0, 1], [1.35, 1])}) translateX(${-exit * 1200}px)`, opacity: Math.min(1, land * 1.4) }}>
        <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: C.fg2 }}>Deal · round trip</div>
        <div style={{ fontFamily: SERIF, fontSize: long ? 72 : 92, color: C.fg, marginTop: 14, lineHeight: 1 }}>{hero.from} → {hero.to}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginTop: 30 }}>
          <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 210, color: idx === 3 ? C.accent : C.fg, letterSpacing: "-.04em",
            transform: `scale(${kick})`, transformOrigin: "left bottom", lineHeight: .9, fontVariantNumeric: "tabular-nums" }}>${steps[idx]}</div>
          {idx === 3 && pct ? <div style={{ fontFamily: SANS, fontSize: 52, fontWeight: 600, color: C.fg2, textDecoration: "line-through" }}>${top}</div> : null}
        </div>
        {pct ? (
          <div style={{ display: "inline-block", marginTop: 28, padding: "14px 28px", borderRadius: 999, background: "rgba(90,212,138,.18)",
            color: C.ok, fontFamily: SANS, fontWeight: 700, fontSize: 40, opacity: pill, transform: `scale(${0.6 + 0.4 * pill})`, transformOrigin: "left center" }}>
            {pct}% below the usual price
          </div>
        ) : null}
        <div style={{ fontFamily: SANS, fontSize: 38, fontWeight: 500, color: C.fg2, marginTop: 28, opacity: details, transform: `translateY(${(1 - details) * 20}px)` }}>
          {hero.dates}{hero.airline ? ` · ${hero.airline}` : ""}
        </div>
      </Glass>
    </AbsoluteFill>
  );
};

const Row: React.FC<{ at: number; d: Deal }> = ({ at, d }) => {
  const s = useHit(at, 260, 17);
  const g = Math.min(1, s * 1.6);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${30 * g}px 40px`,
      borderTop: "1.5px solid rgba(255,255,255,.12)", opacity: s, transform: `translateX(${(1 - s) * 260}px)`,
      maxHeight: `${g * 170}px`, overflow: "hidden", boxSizing: "border-box" }}>
      <div>
        <div style={{ fontFamily: SANS, fontSize: 50, fontWeight: 700, color: C.fg }}>{d.to}</div>
        <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 500, color: C.fg2, marginTop: 4 }}>from {d.origin ?? d.from} · round trip</div>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 70, fontWeight: 800, color: C.accent, letterSpacing: "-.03em" }}>${d.price}</div>
    </div>
  );
};

const List: React.FC = () => {
  const f = useCurrentFrame();
  const b = useB();
  const { list } = useProps();
  const { height } = useVideoConfig();
  const head = useHit(b(16), 220, 18);
  const exit = interpolate(f, [b(23), b(24)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tall = height > 1500;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - exit, transform: `translateY(${-exit * 120}px)` }}>
      <div style={{ width: 900 }}>
        <div style={{ fontFamily: SERIF, fontSize: tall ? 104 : 84, color: C.fg, lineHeight: 1.02, marginBottom: 34, opacity: head, transform: `translateY(${(1 - head) * 30}px)` }}>
          Checked every hour.<br /><span style={{ fontStyle: "italic", color: C.fg2 }}>Found this week:</span>
        </div>
        <Glass style={{ overflow: "hidden", opacity: head }}>
          {list.slice(0, tall ? 5 : 3).map((d, i) => <Row key={`${d.to}${i}`} at={b(17 + i)} d={d} />)}
        </Glass>
      </div>
    </AbsoluteFill>
  );
};

const Alert: React.FC = () => {
  const f = useCurrentFrame();
  const b = useB();
  const { alert } = useProps();
  const drop = useHit(b(24), 240, 16);
  const line = useHit(b(26), 200, 18);
  const exit = interpolate(f, [b(28), b(29)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - exit }}>
      <div style={{ width: 920 }}>
        <Glass style={{ padding: "34px 40px", borderRadius: 40, transform: `translateY(${(1 - drop) * -500}px)` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: C.accent, display: "grid", placeItems: "center", fontSize: 36 }}>✈</div>
            <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 32, color: C.fg }}>Fare Radar</div>
            <div style={{ marginLeft: "auto", fontFamily: SANS, fontSize: 28, color: C.fg2 }}>now</div>
          </div>
          <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 42, color: C.fg, marginTop: 22 }}>{alert.from} → {alert.to} ${alert.price} round trip</div>
          <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 34, color: C.fg2, marginTop: 8 }}>{[alert.airline, alert.dates].filter(Boolean).join(" · ")}</div>
        </Glass>
        <div style={{ fontFamily: SERIF, fontSize: 96, color: C.fg, marginTop: 60, lineHeight: 1.02, opacity: line, transform: `translateY(${(1 - line) * 30}px)` }}>
          One email when it's <span style={{ fontStyle: "italic", color: C.accent }}>worth it.</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const EndCard: React.FC<{ at: number; fine?: string }> = ({ at, fine }) => {
  const mark = useHit(at, 200, 16);
  const sub = useHit(at + 13, 200, 18);
  const btn = useHit(at + 26, 300, 13);
  const small = useHit(at + 52, 120, 20);
  const { height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div style={{ fontFamily: SERIF, fontSize: height > 1500 ? 190 : 160, color: C.fg, lineHeight: 1, opacity: mark, transform: `scale(${0.85 + 0.15 * mark})` }}>Fare Radar</div>
      <div style={{ fontFamily: SANS, fontSize: 46, fontWeight: 600, color: C.fg2, marginTop: 28, opacity: sub }}>
        Cheap flights out of Seattle &amp; Portland.<br />Found for you. Free.
      </div>
      <div style={{ marginTop: 60, padding: "30px 64px", borderRadius: 999, background: C.accent, color: C.ink, fontFamily: SANS,
        fontWeight: 800, fontSize: 58, boxShadow: "0 18px 50px rgba(246,180,67,.4)", opacity: btn, transform: `scale(${0.7 + 0.3 * btn})` }}>
        fareradar.cc
      </div>
      {fine ? (
        <div style={{ position: "absolute", bottom: height > 1500 ? 120 : 50, fontFamily: SANS, fontSize: 24, color: "rgba(236,242,238,.55)", opacity: small }}>{fine}</div>
      ) : null}
    </AbsoluteFill>
  );
};

const Show: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => {
  const f = useCurrentFrame();
  return f >= from && f < to ? <>{children}</> : null;
};

const Scenes: React.FC = () => {
  const b = useB();
  const pulse = usePulse();
  const { month } = useProps();
  return (
    <AbsoluteFill style={{ transform: `scale(${pulse})` }}>
      <Show from={0} to={b(DROP)}><Intro /></Show>
      <Show from={b(DROP)} to={b(16)}><DealCard /></Show>
      <Show from={b(16)} to={b(24)}><List /></Show>
      <Show from={b(24)} to={b(29)}><Alert /></Show>
      <Show from={b(29)} to={99999}><EndCard at={b(29)} fine={`Real fares found by Fare Radar, ${month}. Prices change fast.`} /></Show>
    </AbsoluteFill>
  );
};

export const Ad: React.FC<AdProps> = (props) => (
  <Ctx.Provider value={props}>
    <AbsoluteFill style={{ background: C.bg }}>
      <Fonts />
      <Audio src={staticFile(props.audio)} />
      <Background />
      <IntroClips />
      <Scenes />
    </AbsoluteFill>
  </Ctx.Provider>
);

export { C, Fonts, Glass, SANS, SERIF };
