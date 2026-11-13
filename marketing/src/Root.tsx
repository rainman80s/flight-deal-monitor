import React from "react";
import { Composition } from "remotion";
import { Ad, type AdProps, DEFAULT_PROPS } from "./Ad";
import { Founder, type FounderProps, Trip, type TripProps } from "./Extra";

const FPS = 30;

export const Root: React.FC = () => (
  <>
    <Composition id="DealDropVertical" component={Ad} durationInFrames={450} fps={FPS} width={1080} height={1920} defaultProps={DEFAULT_PROPS} />
    <Composition id="DealDropSquare" component={Ad} durationInFrames={450} fps={FPS} width={1080} height={1080} defaultProps={DEFAULT_PROPS} />
    <Composition id="TripEdit" component={Trip} durationInFrames={450} fps={FPS} width={1080} height={1920}
      defaultProps={{ beats: DEFAULT_PROPS.beats, audio: "cut.mp3", clips: [], photos: [], deal: DEFAULT_PROPS.hero, caption: "Go somewhere." } as TripProps} />
    <Composition id="Founder" component={Founder} fps={FPS} width={1080} height={1920} durationInFrames={300}
      defaultProps={{ video: "talk.mp4", seconds: 7, name: null } as FounderProps}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round((props.seconds + 3) * FPS) })} />
  </>
);

export type { AdProps };
