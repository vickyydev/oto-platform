import type { CSSProperties } from 'react';

/**
 * The OTO wordmark, drawn as live text.
 *
 * Lifted unchanged in substance from the outgoing game, where it replaced a
 * 13250 x 10842 px PNG export that cost the booth a four-megabyte download and
 * a half-gigabyte bitmap decode on every boot. Text costs nothing, stays sharp
 * at television size, and needs no licensed artwork copied out of `imports/`
 * (D23) — the letterforms come from whatever face the stack resolves to.
 */

/* Sampled from the original logo artwork so the text matches the brand. */
const ORANGE = '#F38E60';
const PINK = '#E18FBD';
const LIME = '#C2CE48';
const INK = '#141110';

interface Props {
  /** Total block height in px — the word and the strapline both scale from it. */
  height: number;
  style?: CSSProperties;
}

export default function OtoWordmark({ height, style }: Props) {
  const word = Math.round(height * 0.62);
  const sub = Math.max(6, Math.round(height * 0.108));

  return (
    <span
      data-wordmark="oto"
      role="img"
      aria-label="OTO Play Park & Restaurant"
      style={{ display: 'inline-block', textAlign: 'right', lineHeight: 1, ...style }}
    >
      <span
        style={{
          display: 'block',
          fontFamily: '"Benzin", system-ui, sans-serif',
          fontWeight: 600,
          fontSize: word,
          // Slight negative tracking so the three letters hug like the artwork.
          letterSpacing: -Math.round(word * 0.03),
          lineHeight: 1,
        }}
      >
        <span style={{ color: ORANGE }}>O</span>
        <span style={{ color: PINK }}>t</span>
        <span style={{ color: LIME }}>o</span>
      </span>
      <span
        style={{
          display: 'block',
          marginTop: Math.round(height * 0.05),
          fontFamily: '"Montserrat", system-ui, sans-serif',
          fontWeight: 700,
          fontSize: sub,
          lineHeight: 1.15,
          letterSpacing: 0.2,
          color: INK,
        }}
      >
        Play park
        <br />
        &amp; restaurant
      </span>
    </span>
  );
}
