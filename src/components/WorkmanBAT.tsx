import { AbsoluteFill, Img, staticFile, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";

const batConfig = {
  vetement: "Veste de cuisinier",
  couleur: "Noir",
  zones: ["poitrine_gauche"],
  logo: "WorkMan Workwear Solutions",
  technique: "broderie",
  details: {
    taille: "9cm",
    couleur_fil: "blanc",
    pantone: "White",
  },
};

export const WorkmanBAT: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  const logoOpacity = spring({ frame: frame - 30, fps, config: { damping: 20, stiffness: 80 } });
  const logoScale = interpolate(logoOpacity, [0, 1], [0.7, 1]);

  const badgeOpacity = spring({ frame: frame - 60, fps, config: { damping: 18, stiffness: 60 } });

  return (
    <AbsoluteFill style={{ backgroundColor: "#1a1a1a", fontFamily: "sans-serif", opacity: fadeIn }}>

      {/* Header */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 80,
        background: "linear-gradient(90deg, #1e2d5a 0%, #2a3f7e 100%)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 40px", zIndex: 10,
      }}>
        <div style={{ color: "#fff", fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>
          WORKMAN BAT
        </div>
        <div style={{ color: "#ffd700", fontSize: 18, fontWeight: 500 }}>
          Bon À Tirer — Maquette Textile
        </div>
      </div>

      {/* Main layout */}
      <div style={{
        position: "absolute", top: 80, bottom: 0, left: 0, right: 0,
        display: "flex",
      }}>

        {/* Left: product image */}
        <div style={{
          flex: "0 0 55%", position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "radial-gradient(ellipse at center, #2c2c2c 0%, #111 100%)",
        }}>
          <Img
            src={staticFile("workwear/02.jpg")}
            style={{ maxHeight: "85%", maxWidth: "85%", objectFit: "contain", borderRadius: 8 }}
          />

          {/* Logo overlay on left chest */}
          <div style={{
            position: "absolute",
            top: "28%",
            left: "35%",
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
            transformOrigin: "center",
          }}>
            {/* Embroidery frame indicator */}
            <div style={{
              border: "2px dashed rgba(255,255,255,0.5)",
              borderRadius: 6,
              padding: "10px 14px",
              background: "rgba(0,0,0,0.35)",
              backdropFilter: "blur(4px)",
            }}>
              {/* WorkMan logo in white (broderie simulation) */}
              <div style={{ textAlign: "center", lineHeight: 1.1 }}>
                <div style={{
                  color: "#fff",
                  fontSize: 22,
                  fontWeight: 900,
                  letterSpacing: 1,
                  textShadow: "0 0 8px rgba(255,255,255,0.4)",
                  fontFamily: "Arial Black, sans-serif",
                }}>
                  Wor<span style={{ fontStyle: "italic" }}>K</span>man
                </div>
                <div style={{
                  color: "rgba(255,255,255,0.85)",
                  fontSize: 8,
                  letterSpacing: 1.5,
                  fontWeight: 600,
                  textTransform: "uppercase",
                }}>
                  Workwear Solutions
                </div>
              </div>
            </div>

            {/* Size indicator */}
            <div style={{
              position: "absolute", bottom: -22, left: "50%",
              transform: "translateX(-50%)",
              color: "#ffd700", fontSize: 10, whiteSpace: "nowrap",
              fontWeight: 600,
            }}>
              ← 9 cm →
            </div>
          </div>

          {/* Zone callout arrow */}
          {logoOpacity > 0.5 && (
            <div style={{
              position: "absolute", top: "26%", left: "58%",
              opacity: logoOpacity,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <div style={{ width: 40, height: 2, background: "#ffd700" }} />
              <div style={{
                background: "#ffd700", color: "#1a1a1a",
                fontSize: 10, fontWeight: 700, padding: "3px 8px",
                borderRadius: 4, whiteSpace: "nowrap",
              }}>
                Poitrine gauche
              </div>
            </div>
          )}
        </div>

        {/* Right: BAT details panel */}
        <div style={{
          flex: 1,
          background: "#f4f4f4",
          padding: "32px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          opacity: badgeOpacity,
        }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#1e2d5a", borderBottom: "3px solid #1e2d5a", paddingBottom: 10 }}>
            Fiche Technique
          </div>

          {[
            { label: "Vêtement", value: batConfig.vetement },
            { label: "Couleur", value: batConfig.couleur },
            { label: "Zone", value: "Poitrine gauche" },
            { label: "Technique", value: "Broderie" },
            { label: "Taille logo", value: batConfig.details.taille },
            { label: "Couleur fil", value: "Blanc (White)" },
            { label: "Pantone", value: batConfig.details.pantone },
          ].map(({ label, value }) => (
            <div key={label} style={{
              display: "flex", flexDirection: "column", gap: 2,
              borderBottom: "1px solid #ddd", paddingBottom: 10,
            }}>
              <div style={{ fontSize: 11, color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
                {label}
              </div>
              <div style={{ fontSize: 16, color: "#1a1a1a", fontWeight: 600 }}>
                {value}
              </div>
            </div>
          ))}

          {/* Status badge */}
          <div style={{
            marginTop: "auto",
            background: "#1e2d5a",
            color: "#fff",
            borderRadius: 8,
            padding: "14px 20px",
            fontSize: 13,
            fontWeight: 700,
            textAlign: "center",
            letterSpacing: 1,
          }}>
            EN ATTENTE DE VALIDATION CLIENT
          </div>

          <div style={{ fontSize: 11, color: "#aaa", textAlign: "center" }}>
            Workman Workwear Solutions — BAT #{new Date().getFullYear()}-001
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
