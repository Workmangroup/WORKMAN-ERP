import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

const FPS = 24;
const SLIDE_FRAMES = FPS * 2; // 2 s per image
const TRANSITION_FRAMES = Math.floor(FPS * 0.45); // ~11 frames cross-dissolve
const STEP_FRAMES = SLIDE_FRAMES - TRANSITION_FRAMES; // 37 frames between starts

type Slide = {
  src: string;
  startScale: number;
  endScale: number;
  panX: number; // % of frame width, applied over slide duration
  panY: number; // % of frame height
};

const SLIDES: Slide[] = [
  {
    src: "workwear/01.jpg",
    startScale: 1.0,
    endScale: 1.13,
    panX: 1.5,
    panY: -1.0,
  },
  {
    src: "workwear/02.jpg",
    startScale: 1.08,
    endScale: 1.18,
    panX: -1.8,
    panY: 1.2,
  },
  {
    src: "workwear/03.jpg",
    startScale: 1.0,
    endScale: 1.12,
    panX: 1.2,
    panY: 1.5,
  },
  {
    src: "workwear/04.jpg",
    startScale: 1.05,
    endScale: 1.15,
    panX: -1.5,
    panY: -0.8,
  },
  {
    src: "workwear/05.jpg",
    startScale: 1.0,
    endScale: 1.1,
    panX: 0.8,
    panY: 1.0,
  },
];

export const WORKWEAR_TOTAL_FRAMES =
  STEP_FRAMES * (SLIDES.length - 1) + SLIDE_FRAMES;
// = 37 * 4 + 48 = 196 frames ≈ 8.2 s at 24 fps

// ---------------------------------------------------------------------------
// Single cinematic slide with Ken Burns + cross-dissolve fade
// ---------------------------------------------------------------------------
const CinematicSlide: React.FC<Slide> = ({
  src,
  startScale,
  endScale,
  panX,
  panY,
}) => {
  const frame = useCurrentFrame();

  const progress = interpolate(frame, [0, SLIDE_FRAMES - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });

  const scale = startScale + (endScale - startScale) * progress;
  // translate before scale so the % is relative to the unscaled element
  const tx = panX * progress;
  const ty = panY * progress;

  // Fade in at start, fade out at end for cross-dissolve blending
  const opacity = interpolate(
    frame,
    [0, TRANSITION_FRAMES, SLIDE_FRAMES - TRANSITION_FRAMES, SLIDE_FRAMES],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    },
  );

  return (
    <AbsoluteFill style={{ opacity, overflow: "hidden" }}>
      <Img
        src={staticFile(src)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${tx}%, ${ty}%)`,
          transformOrigin: "center center",
          // Gentle cinematic color grade
          filter: "contrast(1.08) saturate(1.12) brightness(0.97)",
        }}
      />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Radial vignette burned over every frame
// ---------------------------------------------------------------------------
const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      background:
        "radial-gradient(ellipse at 50% 50%, transparent 48%, rgba(0,0,0,0.70) 100%)",
      pointerEvents: "none",
    }}
  />
);

// ---------------------------------------------------------------------------
// Per-frame film grain via SVG fractalNoise with a rotating seed
// ---------------------------------------------------------------------------
const FilmGrain: React.FC = () => {
  const frame = useCurrentFrame();
  const seed = frame % 97; // prime to avoid repetition pattern
  const id = `fg${seed}`;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity: 0.055,
        mixBlendMode: "overlay",
      }}
    >
      <svg
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block" }}
      >
        <defs>
          <filter id={id} x="0" y="0" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.88"
              numOctaves="4"
              seed={seed}
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Cinematic 2.39 : 1 letterbox (black bars, top & bottom)
// In a 16:9 frame: barHeight = H × (1 − (16/9) / 2.39) / 2 ≈ 12.8 %
// ---------------------------------------------------------------------------
const Letterbox: React.FC = () => {
  const barStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    height: "12.81%",
    backgroundColor: "#000",
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...barStyle, top: 0 }} />
      <div style={{ ...barStyle, bottom: 0 }} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Root composition
// ---------------------------------------------------------------------------
export const WorkwearCinematic: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {SLIDES.map((slide, index) => (
        <Sequence
          key={index}
          from={index * STEP_FRAMES}
          durationInFrames={SLIDE_FRAMES}
        >
          <CinematicSlide {...slide} />
        </Sequence>
      ))}
      <Vignette />
      <FilmGrain />
      <Letterbox />
    </AbsoluteFill>
  );
};
