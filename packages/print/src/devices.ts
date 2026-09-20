/**
 * Device profiles for rendering.
 *
 * This is **not** the device record — S2-04 owns that, with the park's real
 * addresses from `docs/architecture/DEVICE_INVENTORY.md` §2. What lives here is
 * the small shape the renderer needs and two constructors so a caller building
 * a profile from a device row cannot forget `widthDots`.
 *
 * `widthDots` is the field to be careful with. The XP-80 family ships as "576
 * dots/line **or** 512 dots/line" depending on the unit, the Windows driver
 * name identifies nothing (most of the family installs as "XP-80C", the C260
 * included), and the only reliable source is the self-test page — power off,
 * hold FEED, power on, release after 2-3 s. Until four self-test pages have
 * been read, the seed guesses 576 and that guess is flagged (D6).
 */

import type { DeviceProfile } from './document';

export interface EscposProfileInput {
  id: string;
  label: string;
  /** From the self-test page. */
  model: string;
  /** 576 on the Welltech G4; 576 or 512 across the XP-80 family. */
  widthDots?: number;
  hasCutter?: boolean;
  hasDrawer?: boolean;
  bandRows?: number;
}

export function escposProfile(input: EscposProfileInput): DeviceProfile {
  return {
    id: input.id,
    label: input.label,
    model: input.model,
    language: 'escpos',
    widthDots: input.widthDots ?? 576,
    dpi: 203,
    bandRows: input.bandRows ?? 128,
    hasCutter: input.hasCutter ?? true,
    hasDrawer: input.hasDrawer ?? false,
  };
}

export interface TsplProfileInput {
  id: string;
  label: string;
  model: string;
  /** 8 dots/mm at 203 dpi: a 50 mm band is 400 dots, a 25 mm band 200. */
  widthDots: number;
  media: NonNullable<DeviceProfile['media']>;
  density?: number;
  speed?: number;
  perLabelAck?: boolean;
}

export function tsplProfile(input: TsplProfileInput): DeviceProfile {
  return {
    id: input.id,
    label: input.label,
    model: input.model,
    language: 'tspl2',
    widthDots: input.widthDots,
    dpi: 203,
    media: input.media,
    density: input.density ?? 10,
    speed: input.speed ?? 4,
    // `SET RESPONSE ON` is firmware >= V7.09 and unconfirmed on these units;
    // off by default means the adapter polls `ESC ! ?` after `PRINT` instead.
    perLabelAck: input.perLabelAck ?? false,
    hasCutter: false,
    hasDrawer: false,
  };
}

/** 8 dots per millimetre at 203 dpi. */
export function mmToDots(mm: number): number {
  return Math.round(mm * 8);
}
