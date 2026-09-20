import { forwardRef } from "react";
import { Megaphone, MapPin, DollarSign, CheckCircle, Star, Phone, Mail, Link2 } from "lucide-react";

export type AspectRatio = "1:1" | "4:5" | "9:16";

export interface HiringPostData {
  positionTitle: string;
  branchName: string;
  employmentType?: "full_time" | "part_time" | "casual" | null;
  jobDescription?: string | null;
  keyResponsibilities?: string[] | null;
  requirements?: string[] | null;
  salaryRange?: string | null;
  benefits?: string[] | null;
  contactPhone?: string | null;
  contactLine?: string | null;
  contactEmail?: string | null;
  applyUrl?: string | null;
  backgroundImage?: string | null;
  companyLogo?: string | null;
  companyName?: string;
  primaryColor?: string;
  accentColor?: string;
}

const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

const employmentTypeLabels: Record<string, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  casual: "Casual",
};

interface TemplateProps {
  data: HiringPostData;
  aspectRatio: AspectRatio;
  scale?: number;
}

export const ModernTemplate = forwardRef<HTMLDivElement, TemplateProps>(
  ({ data, aspectRatio, scale = 0.3 }, ref) => {
    const dims = ASPECT_DIMENSIONS[aspectRatio];
    const scaledWidth = dims.width * scale;
    const scaledHeight = dims.height * scale;
    const primaryColor = data.primaryColor || "#6366f1";
    const accentColor = data.accentColor || "#f59e0b";

    return (
      <div
        ref={ref}
        style={{
          width: scaledWidth,
          height: scaledHeight,
          fontSize: `${16 * scale}px`,
          position: "relative",
          overflow: "hidden",
          fontFamily: "'Inter', sans-serif",
        }}
        className="rounded-lg shadow-lg"
      >
        {data.backgroundImage ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url(${data.backgroundImage})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.85) 100%)",
              }}
            />
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}dd 100%)`,
            }}
          />
        )}

        <div
          style={{
            position: "relative",
            height: "100%",
            padding: `${24 * scale}px`,
            display: "flex",
            flexDirection: "column",
            color: "white",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: `${8 * scale}px`, marginBottom: `${16 * scale}px` }}>
            <div
              style={{
                background: accentColor,
                padding: `${6 * scale}px ${12 * scale}px`,
                borderRadius: `${20 * scale}px`,
                fontSize: `${14 * scale}px`,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: `${4 * scale}px`,
              }}
            >
              <Megaphone style={{ width: `${14 * scale}px`, height: `${14 * scale}px` }} />
              WE'RE HIRING
            </div>
            {data.employmentType && (
              <div
                style={{
                  background: "rgba(255,255,255,0.2)",
                  padding: `${6 * scale}px ${12 * scale}px`,
                  borderRadius: `${20 * scale}px`,
                  fontSize: `${12 * scale}px`,
                }}
              >
                {employmentTypeLabels[data.employmentType] || data.employmentType}
              </div>
            )}
          </div>

          <h1
            style={{
              fontSize: `${32 * scale}px`,
              fontWeight: 800,
              lineHeight: 1.1,
              marginBottom: `${8 * scale}px`,
              textShadow: "0 2px 4px rgba(0,0,0,0.3)",
            }}
          >
            {data.positionTitle}
          </h1>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: `${6 * scale}px`,
              fontSize: `${14 * scale}px`,
              opacity: 0.9,
              marginBottom: `${16 * scale}px`,
            }}
          >
            <MapPin style={{ width: `${14 * scale}px`, height: `${14 * scale}px` }} />
            {data.branchName}
          </div>

          {data.salaryRange && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: `${6 * scale}px`,
                fontSize: `${16 * scale}px`,
                fontWeight: 600,
                marginBottom: `${16 * scale}px`,
                color: accentColor,
              }}
            >
              <DollarSign style={{ width: `${16 * scale}px`, height: `${16 * scale}px` }} />
              {data.salaryRange}
            </div>
          )}

          <div style={{ flex: 1, overflow: "hidden" }}>
            {data.requirements && data.requirements.length > 0 && aspectRatio !== "1:1" && (
              <div style={{ marginBottom: `${12 * scale}px` }}>
                <div
                  style={{
                    fontSize: `${12 * scale}px`,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    opacity: 0.7,
                    marginBottom: `${8 * scale}px`,
                  }}
                >
                  Requirements
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: `${6 * scale}px` }}>
                  {data.requirements.slice(0, aspectRatio === "9:16" ? 5 : 3).map((req, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: `${6 * scale}px`,
                        fontSize: `${13 * scale}px`,
                      }}
                    >
                      <CheckCircle style={{ width: `${14 * scale}px`, height: `${14 * scale}px`, flexShrink: 0, marginTop: `${2 * scale}px`, color: accentColor }} />
                      <span>{req}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.benefits && data.benefits.length > 0 && aspectRatio !== "1:1" && (
              <div style={{ marginBottom: `${12 * scale}px` }}>
                <div
                  style={{
                    fontSize: `${12 * scale}px`,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    opacity: 0.7,
                    marginBottom: `${8 * scale}px`,
                  }}
                >
                  Benefits
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: `${6 * scale}px` }}>
                  {data.benefits.slice(0, aspectRatio === "9:16" ? 6 : 4).map((benefit, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: `${4 * scale}px`,
                        fontSize: `${12 * scale}px`,
                        background: "rgba(255,255,255,0.15)",
                        padding: `${4 * scale}px ${10 * scale}px`,
                        borderRadius: `${12 * scale}px`,
                      }}
                    >
                      <Star style={{ width: `${12 * scale}px`, height: `${12 * scale}px`, color: accentColor }} />
                      {benefit}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: `${12 * scale}px`,
              marginTop: "auto",
            }}
          >
            <div
              style={{
                fontSize: `${11 * scale}px`,
                fontWeight: 600,
                textTransform: "uppercase",
                opacity: 0.7,
                marginBottom: `${8 * scale}px`,
              }}
            >
              Apply Now
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: `${8 * scale}px`, fontSize: `${13 * scale}px` }}>
              {data.contactPhone && (
                <div style={{ display: "flex", alignItems: "center", gap: `${4 * scale}px` }}>
                  <Phone style={{ width: `${14 * scale}px`, height: `${14 * scale}px` }} />
                  {data.contactPhone}
                </div>
              )}
              {data.contactLine && (
                <div style={{ display: "flex", alignItems: "center", gap: `${4 * scale}px` }}>
                  <svg style={{ width: `${14 * scale}px`, height: `${14 * scale}px` }} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2Z"/>
                  </svg>
                  LINE: {data.contactLine}
                </div>
              )}
              {data.contactEmail && (
                <div style={{ display: "flex", alignItems: "center", gap: `${4 * scale}px` }}>
                  <Mail style={{ width: `${14 * scale}px`, height: `${14 * scale}px` }} />
                  {data.contactEmail}
                </div>
              )}
            </div>
          </div>

          {data.companyName && (
            <div
              style={{
                position: "absolute",
                bottom: `${12 * scale}px`,
                right: `${12 * scale}px`,
                fontSize: `${11 * scale}px`,
                opacity: 0.6,
              }}
            >
              {data.companyName}
            </div>
          )}
        </div>
      </div>
    );
  }
);

ModernTemplate.displayName = "ModernTemplate";

export const MinimalTemplate = forwardRef<HTMLDivElement, TemplateProps>(
  ({ data, aspectRatio, scale = 0.3 }, ref) => {
    const dims = ASPECT_DIMENSIONS[aspectRatio];
    const scaledWidth = dims.width * scale;
    const scaledHeight = dims.height * scale;
    const primaryColor = data.primaryColor || "#1e293b";
    const accentColor = data.accentColor || "#3b82f6";

    return (
      <div
        ref={ref}
        style={{
          width: scaledWidth,
          height: scaledHeight,
          fontSize: `${16 * scale}px`,
          position: "relative",
          overflow: "hidden",
          fontFamily: "'Inter', sans-serif",
          background: "#ffffff",
        }}
        className="rounded-lg shadow-lg"
      >
        <div
          style={{
            height: "100%",
            padding: `${28 * scale}px`,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              background: accentColor,
              color: "white",
              padding: `${8 * scale}px ${16 * scale}px`,
              borderRadius: `${4 * scale}px`,
              fontSize: `${12 * scale}px`,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: `${1 * scale}px`,
              display: "inline-flex",
              alignSelf: "flex-start",
              marginBottom: `${20 * scale}px`,
            }}
          >
            Now Hiring
          </div>

          <h1
            style={{
              fontSize: `${36 * scale}px`,
              fontWeight: 800,
              color: primaryColor,
              lineHeight: 1.1,
              marginBottom: `${12 * scale}px`,
            }}
          >
            {data.positionTitle}
          </h1>

          <div
            style={{
              fontSize: `${14 * scale}px`,
              color: "#64748b",
              marginBottom: `${20 * scale}px`,
              display: "flex",
              alignItems: "center",
              gap: `${6 * scale}px`,
            }}
          >
            <MapPin style={{ width: `${14 * scale}px`, height: `${14 * scale}px` }} />
            {data.branchName}
            {data.employmentType && (
              <>
                <span style={{ margin: `0 ${4 * scale}px` }}>•</span>
                {employmentTypeLabels[data.employmentType]}
              </>
            )}
          </div>

          {data.salaryRange && (
            <div
              style={{
                fontSize: `${20 * scale}px`,
                fontWeight: 700,
                color: accentColor,
                marginBottom: `${20 * scale}px`,
              }}
            >
              {data.salaryRange}
            </div>
          )}

          <div style={{ flex: 1 }}>
            {data.requirements && data.requirements.length > 0 && (
              <div style={{ marginBottom: `${16 * scale}px` }}>
                <div
                  style={{
                    fontSize: `${11 * scale}px`,
                    fontWeight: 700,
                    color: "#94a3b8",
                    textTransform: "uppercase",
                    letterSpacing: `${0.5 * scale}px`,
                    marginBottom: `${10 * scale}px`,
                  }}
                >
                  What we're looking for
                </div>
                {data.requirements.slice(0, aspectRatio === "1:1" ? 3 : 4).map((req, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: `${13 * scale}px`,
                      color: "#475569",
                      paddingLeft: `${12 * scale}px`,
                      borderLeft: `${3 * scale}px solid ${accentColor}`,
                      marginBottom: `${8 * scale}px`,
                    }}
                  >
                    {req}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              borderTop: `${1 * scale}px solid #e2e8f0`,
              paddingTop: `${16 * scale}px`,
              marginTop: "auto",
            }}
          >
            <div
              style={{
                fontSize: `${11 * scale}px`,
                fontWeight: 700,
                color: "#94a3b8",
                textTransform: "uppercase",
                letterSpacing: `${0.5 * scale}px`,
                marginBottom: `${8 * scale}px`,
              }}
            >
              Get in touch
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: `${6 * scale}px`, fontSize: `${13 * scale}px`, color: "#334155" }}>
              {data.contactPhone && (
                <div style={{ display: "flex", alignItems: "center", gap: `${6 * scale}px` }}>
                  <Phone style={{ width: `${14 * scale}px`, height: `${14 * scale}px`, color: accentColor }} />
                  {data.contactPhone}
                </div>
              )}
              {data.contactEmail && (
                <div style={{ display: "flex", alignItems: "center", gap: `${6 * scale}px` }}>
                  <Mail style={{ width: `${14 * scale}px`, height: `${14 * scale}px`, color: accentColor }} />
                  {data.contactEmail}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

MinimalTemplate.displayName = "MinimalTemplate";

export const BoldTemplate = forwardRef<HTMLDivElement, TemplateProps>(
  ({ data, aspectRatio, scale = 0.3 }, ref) => {
    const dims = ASPECT_DIMENSIONS[aspectRatio];
    const scaledWidth = dims.width * scale;
    const scaledHeight = dims.height * scale;
    const primaryColor = data.primaryColor || "#dc2626";
    const accentColor = data.accentColor || "#fbbf24";

    return (
      <div
        ref={ref}
        style={{
          width: scaledWidth,
          height: scaledHeight,
          fontSize: `${16 * scale}px`,
          position: "relative",
          overflow: "hidden",
          fontFamily: "'Inter', sans-serif",
          background: "#000000",
          color: "white",
        }}
        className="rounded-lg shadow-lg"
      >
        {data.backgroundImage && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url(${data.backgroundImage})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              opacity: 0.3,
            }}
          />
        )}

        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: `${80 * scale}px`,
            background: primaryColor,
            transform: "skewY(-3deg)",
            transformOrigin: "top left",
          }}
        />

        <div
          style={{
            position: "relative",
            height: "100%",
            padding: `${24 * scale}px`,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              fontSize: `${14 * scale}px`,
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: `${3 * scale}px`,
              marginBottom: `${24 * scale}px`,
            }}
          >
            JOIN OUR TEAM
          </div>

          <h1
            style={{
              fontSize: `${40 * scale}px`,
              fontWeight: 900,
              lineHeight: 0.95,
              marginBottom: `${16 * scale}px`,
              textTransform: "uppercase",
            }}
          >
            {data.positionTitle}
          </h1>

          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: `${8 * scale}px`,
              background: accentColor,
              color: "#000",
              padding: `${8 * scale}px ${16 * scale}px`,
              fontWeight: 800,
              fontSize: `${14 * scale}px`,
              marginBottom: `${20 * scale}px`,
              alignSelf: "flex-start",
            }}
          >
            <MapPin style={{ width: `${16 * scale}px`, height: `${16 * scale}px` }} />
            {data.branchName}
          </div>

          {data.salaryRange && (
            <div
              style={{
                fontSize: `${24 * scale}px`,
                fontWeight: 900,
                color: accentColor,
                marginBottom: `${20 * scale}px`,
              }}
            >
              {data.salaryRange}
            </div>
          )}

          <div style={{ flex: 1 }}>
            {data.benefits && data.benefits.length > 0 && aspectRatio !== "1:1" && (
              <div style={{ marginBottom: `${16 * scale}px` }}>
                <div
                  style={{
                    fontSize: `${12 * scale}px`,
                    fontWeight: 800,
                    textTransform: "uppercase",
                    letterSpacing: `${1 * scale}px`,
                    opacity: 0.6,
                    marginBottom: `${10 * scale}px`,
                  }}
                >
                  What you get
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: `${8 * scale}px` }}>
                  {data.benefits.slice(0, 4).map((benefit, i) => (
                    <div
                      key={i}
                      style={{
                        background: primaryColor,
                        padding: `${6 * scale}px ${12 * scale}px`,
                        fontSize: `${12 * scale}px`,
                        fontWeight: 700,
                      }}
                    >
                      {benefit}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              borderTop: `${2 * scale}px solid ${primaryColor}`,
              paddingTop: `${16 * scale}px`,
              marginTop: "auto",
            }}
          >
            <div
              style={{
                fontSize: `${16 * scale}px`,
                fontWeight: 900,
                textTransform: "uppercase",
                marginBottom: `${8 * scale}px`,
              }}
            >
              Apply Now
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: `${6 * scale}px`, fontSize: `${14 * scale}px` }}>
              {data.contactPhone && (
                <div style={{ display: "flex", alignItems: "center", gap: `${8 * scale}px` }}>
                  <Phone style={{ width: `${16 * scale}px`, height: `${16 * scale}px`, color: accentColor }} />
                  {data.contactPhone}
                </div>
              )}
              {data.contactLine && (
                <div style={{ display: "flex", alignItems: "center", gap: `${8 * scale}px` }}>
                  LINE: {data.contactLine}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

BoldTemplate.displayName = "BoldTemplate";

export const TEMPLATE_OPTIONS = [
  { id: "modern", name: "Modern", component: ModernTemplate },
  { id: "minimal", name: "Minimal", component: MinimalTemplate },
  { id: "bold", name: "Bold", component: BoldTemplate },
] as const;

export type TemplateId = typeof TEMPLATE_OPTIONS[number]["id"];

export function getTemplateComponent(templateId: TemplateId) {
  return TEMPLATE_OPTIONS.find((t) => t.id === templateId)?.component || ModernTemplate;
}
