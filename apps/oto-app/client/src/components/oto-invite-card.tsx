import { CalendarDays, Clock, MapPin } from "lucide-react";
import { formatDateForLanguage, formatTimeForLanguage, getOrdinal, type ParentExperienceLanguage } from "@shared/localization";

const OTO = {
  orange:    "#E8734A",
  pink:      "#D95BA3",
  lightPink: "#E8A8C8",
  yellow:    "#F2D94E",
  teal:      "#4AABBF",
  blue:      "#7AABD4",
  lime:      "#A3B832",
  bg:        "#FDF8F2",
};

interface OtoInviteCardProps {
  childName: string;
  ageTurning?: number | null;
  eventDate: string;
  startTime: string;
  endTime?: string | null;
  locationName?: string | null;
  photoUrl?: string | null;
  language?: ParentExperienceLanguage;
  compact?: boolean;
}

export function OtoInviteCard({
  childName,
  ageTurning,
  eventDate,
  startTime,
  endTime,
  locationName,
  photoUrl,
  language = "en",
  compact = false,
}: OtoInviteCardProps) {
  const eventDateObj = new Date(eventDate);
  const formattedDate = formatDateForLanguage(eventDateObj, language);
  const formattedTime =
    formatTimeForLanguage(startTime, language) +
    (endTime ? ` – ${formatTimeForLanguage(endTime, language)}` : "");

  const ordinalAge = ageTurning ? getOrdinal(ageTurning) : null;
  const birthdayLine = ordinalAge
    ? `${childName}'s ${ordinalAge} Birthday Party`
    : `${childName}'s Birthday Party`;

  const bandH = compact ? 10 : 14;

  return (
    <div
      className="relative overflow-hidden select-none"
      style={{
        borderRadius: compact ? 16 : 24,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        background: "linear-gradient(135deg, #FFE8F4 0%, #FFF4DC 40%, #E8F6FF 100%)",
        boxShadow: "0 8px 40px rgba(232,115,74,0.18), 0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      {/* Top rainbow band */}
      <div style={{
        height: bandH,
        background: `linear-gradient(90deg, ${OTO.orange} 0%, ${OTO.pink} 25%, ${OTO.yellow} 50%, ${OTO.teal} 75%, ${OTO.lime} 100%)`,
        flexShrink: 0,
      }} />

      {/* Corner shapes */}
      <img src="/oto-assets/shape-pink.png"   alt="" aria-hidden className="absolute pointer-events-none"
        style={{ width: compact ? 68 : 100, top: bandH + 6,  left: 8,  opacity: 0.95, transform: "rotate(-12deg)" }} />
      <img src="/oto-assets/shape-yellow.png" alt="" aria-hidden className="absolute pointer-events-none"
        style={{ width: compact ? 54 : 80,  top: bandH + 8,  right: 8, opacity: 0.95, transform: "rotate(8deg)" }} />
      <img src="/oto-assets/shape-blue.png"   alt="" aria-hidden className="absolute pointer-events-none"
        style={{ width: compact ? 50 : 74,  bottom: bandH + 6, left: 6, opacity: 0.9,  transform: "rotate(10deg)" }} />
      <img src="/oto-assets/shape-green.png"  alt="" aria-hidden className="absolute pointer-events-none"
        style={{ width: compact ? 50 : 74,  bottom: bandH + 6, right: 6, opacity: 0.9, transform: "rotate(-8deg)" }} />

      {/* Confetti dots — decorative, never behind text */}
      {[...Array(10)].map((_, i) => {
        const colors = [OTO.orange, OTO.pink, OTO.yellow, OTO.teal, OTO.lime, OTO.blue];
        const size = compact ? [6,8,5,7,6,8,5,7,6,8][i] : [9,12,7,11,9,12,7,11,9,12][i];
        const positions = compact
          ? [
              { top: 32, left: "28%" }, { top: 48, right: "28%" },
              { top: 70, left: "20%" }, { top: 55, right: "20%" },
              { bottom: 40, left: "24%" }, { bottom: 56, right: "24%" },
              { top: 90, left: "15%" }, { top: 80, right: "15%" },
              { bottom: 72, left: "32%" }, { bottom: 44, right: "32%" },
            ]
          : [
              { top: 48, left: "28%" }, { top: 64, right: "28%" },
              { top: 100, left: "22%" }, { top: 80, right: "22%" },
              { bottom: 60, left: "26%" }, { bottom: 80, right: "26%" },
              { top: 130, left: "18%" }, { top: 115, right: "18%" },
              { bottom: 110, left: "34%" }, { bottom: 65, right: "34%" },
            ];
        return (
          <div key={i} className="absolute rounded-full pointer-events-none"
            style={{ width: size, height: size, background: colors[i % colors.length], opacity: 0.35, ...positions[i] }} />
        );
      })}

      {/* Main content */}
      <div
        className={`relative flex flex-col items-center text-center ${compact ? "px-5 py-4" : "px-8 py-6"}`}
        style={{ zIndex: 1 }}
      >
        {/* "You're Invited" — solid orange badge, white text */}
        <div
          className="font-black tracking-tight leading-none"
          style={{
            fontSize: compact ? 20 : 30,
            color: "#fff",
            background: OTO.orange,
            borderRadius: compact ? 10 : 14,
            padding: compact ? "6px 18px" : "8px 28px",
            boxShadow: `0 4px 14px ${OTO.orange}55`,
            letterSpacing: "-0.3px",
            marginBottom: compact ? 10 : 16,
            display: "inline-block",
          }}
        >
          You're Invited
        </div>

        {/* Child photo with gradient ring */}
        <div
          className="relative"
          style={{
            width: compact ? 84 : 128,
            height: compact ? 84 : 128,
            marginBottom: compact ? 10 : 16,
            background: `conic-gradient(${OTO.orange}, ${OTO.pink}, ${OTO.yellow}, ${OTO.teal}, ${OTO.lime}, ${OTO.orange})`,
            borderRadius: "50%",
            padding: compact ? 3 : 4,
            boxShadow: `0 4px 16px rgba(0,0,0,0.12)`,
          }}
        >
          <div
            className="w-full h-full rounded-full overflow-hidden"
            style={{ background: `${OTO.lightPink}60` }}
          >
            {photoUrl ? (
              <img src={photoUrl} alt={childName} className="w-full h-full object-cover" />
            ) : (
              <img src="/oto-assets/shape-orange.png" alt="" className="w-full h-full object-contain p-3" style={{ opacity: 0.75 }} />
            )}
          </div>
        </div>

        {/* Birthday line — solid pink pill, white text */}
        <div
          className="font-bold leading-tight"
          style={{
            fontSize: compact ? 13 : 18,
            color: "#fff",
            background: OTO.pink,
            borderRadius: compact ? 8 : 12,
            padding: compact ? "5px 14px" : "7px 20px",
            boxShadow: `0 3px 10px ${OTO.pink}44`,
            maxWidth: compact ? 210 : 320,
            marginBottom: compact ? 10 : 18,
            display: "inline-block",
          }}
        >
          {birthdayLine}
        </div>

        {/* Event details — solid white card */}
        <div
          className="w-full rounded-xl space-y-2 text-left"
          style={{
            background: "#fff",
            border: `1.5px solid ${OTO.lightPink}`,
            padding: compact ? "10px 14px" : "14px 20px",
            maxWidth: compact ? 280 : 380,
            boxShadow: "0 2px 10px rgba(217,91,163,0.08)",
          }}
        >
          <div className="flex items-center gap-2" style={{ fontSize: compact ? 12 : 15 }}>
            <CalendarDays className="shrink-0" style={{ width: compact ? 14 : 17, height: compact ? 14 : 17, color: OTO.orange }} />
            <span style={{ color: "#333", fontWeight: 500 }}>{formattedDate}</span>
          </div>
          <div className="flex items-center gap-2" style={{ fontSize: compact ? 12 : 15 }}>
            <Clock className="shrink-0" style={{ width: compact ? 14 : 17, height: compact ? 14 : 17, color: OTO.teal }} />
            <span style={{ color: "#333", fontWeight: 500 }}>{formattedTime}</span>
          </div>
          {locationName && (
            <div className="flex items-center gap-2" style={{ fontSize: compact ? 12 : 15 }}>
              <MapPin className="shrink-0" style={{ width: compact ? 14 : 17, height: compact ? 14 : 17, color: OTO.pink }} />
              <span style={{ color: "#333", fontWeight: 500 }}>{locationName}</span>
            </div>
          )}
        </div>

        {/* Footer branding */}
        <div
          className="font-bold tracking-widest mt-3"
          style={{ fontSize: compact ? 9 : 11, color: OTO.orange, letterSpacing: "0.2em", opacity: 0.8 }}
        >
          OTO BIRTHDAY EXPERIENCE
        </div>
      </div>

      {/* Dragon mascot — bottom-right decorative */}
      <img
        src="/oto-assets/dragon-2.jpg"
        alt=""
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          width: compact ? 52 : 76,
          bottom: bandH + 6,
          right: 10,
          borderRadius: compact ? 8 : 12,
          opacity: 0.92,
          zIndex: 0,
        }}
      />

      {/* Bottom rainbow band */}
      <div style={{
        height: bandH,
        background: `linear-gradient(90deg, ${OTO.lime} 0%, ${OTO.teal} 25%, ${OTO.yellow} 50%, ${OTO.pink} 75%, ${OTO.orange} 100%)`,
        flexShrink: 0,
      }} />
    </div>
  );
}
