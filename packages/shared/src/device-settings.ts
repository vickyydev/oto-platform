import { z } from 'zod';

/**
 * Per-unit device settings — the `core.device.settings` document (S2-06).
 *
 * **Why a column at all, when the model already implies most of this.** Because
 * the device research says it does not. `DEVICE_INVENTORY.md` leaves three
 * facts open per physical unit and each of them changes the bytes we send:
 *
 *  - §9.4 / D6 — the XP-80 family is 576 dots per line on most units and 512 on
 *    some, and the only way to know which is to hold FEED while powering the
 *    printer on and read its self-test page. Two printers with the same model
 *    string can disagree.
 *  - §9.1 / D1 — the 4B-2082A takes TSPL2 natively and ZPL as an emulation, and
 *    which one a given unit is in is not decided until a test label is printed
 *    on site. Band media size is the same kind of fact: it is what is loaded in
 *    the machine, not what the machine is.
 *  - §9.2 / D2 — the DS2278 cradle presents as a USB HID keyboard with a
 *    programmed Enter suffix (parameter #235) or, after one configuration
 *    bar code, as a USB CDC serial device. Both are the same scanner.
 *
 * So these are properties of the unit standing in the park, learned by looking
 * at it, and they belong on its row. Everything that IS implied by the model —
 * the command set, the default profile, the status encoding — stays in
 * `@oto/print`'s device profiles and is not repeated here.
 *
 * An absent section, or an absent key inside one, means "use the profile for
 * this model". Null is not a value here: nothing in this document means
 * "unset the default".
 */

/** 80 mm at 203 dpi is 576 dots on most of the family and 512 on some (§9.4). */
export const ESCPOS_DOTS_PER_LINE = [512, 576] as const;
export type EscposDotsPerLine = (typeof ESCPOS_DOTS_PER_LINE)[number];

/**
 * The Welltech G4 has a partial cutter only (§9.3). `none` is for a unit with
 * no cutter at all, where the paper is torn off by hand.
 */
export const ESCPOS_CUT_MODES = ['partial', 'full', 'none'] as const;
export type EscposCutMode = (typeof ESCPOS_CUT_MODES)[number];

export const EscposDeviceSettingsSchema = z
  .object({
    dotsPerLine: z.union([z.literal(512), z.literal(576)]).optional(),
    cut: z.enum(ESCPOS_CUT_MODES).optional(),
    /**
     * Whether a cash drawer hangs off this printer's RJ11 (§7.3: the drawer is
     * fired by the printer, not by the box). A station with a `cash_drawer`
     * device assigned and this left off is a drawer nothing will open.
     */
    drawerKick: z.boolean().optional(),
    /** Extra paper fed before the cut, in dots, where a unit cuts too close. */
    feedDots: z.number().int().min(0).max(400).optional(),
  })
  .strict();
export type EscposDeviceSettings = z.infer<typeof EscposDeviceSettingsSchema>;

/** TSPL2 native, ZPL as the emulation switch D1 leaves open until a test label. */
export const LABEL_LANGUAGES = ['tspl2', 'zpl'] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

export const LabelDeviceSettingsSchema = z
  .object({
    language: z.enum(LABEL_LANGUAGES).optional(),
    /** The band stock actually loaded, in millimetres. */
    labelWidthMm: z.number().min(10).max(120).optional(),
    labelHeightMm: z.number().min(10).max(400).optional(),
    /** Gap between labels; 0 for continuous stock. */
    gapMm: z.number().min(0).max(20).optional(),
    /** Burn darkness, 0-15 on this family. Too low smudges, too high curls the band. */
    darkness: z.number().int().min(0).max(15).optional(),
    /** Inches per second. */
    speed: z.number().min(1).max(8).optional(),
  })
  .strict();
export type LabelDeviceSettings = z.infer<typeof LabelDeviceSettingsSchema>;

/** How the box reads the scanner (D2, §9.2). */
export const SCANNER_MODES = ['hid', 'cdc'] as const;
export type ScannerMode = (typeof SCANNER_MODES)[number];

/** What the scanner appends after a code. Programmable, so it has to be told. */
export const SCANNER_SUFFIXES = ['enter', 'tab', 'none'] as const;
export type ScannerSuffix = (typeof SCANNER_SUFFIXES)[number];

export const ScannerDeviceSettingsSchema = z
  .object({
    mode: z.enum(SCANNER_MODES).optional(),
    /** `/dev/input/event3` for HID with an exclusive grab, `/dev/ttyACM0` for CDC. */
    devicePath: z.string().max(120).optional(),
    suffix: z.enum(SCANNER_SUFFIXES).optional(),
    /**
     * A burst of keystrokes arriving faster than this, ending in the suffix, is
     * a scan rather than typing. The DS2278 delivers a code in a few
     * milliseconds per character; a person does not.
     */
    burstGapMs: z.number().int().min(5).max(500).optional(),
    /**
     * The key the physical USB button on the counter sends.
     *
     * **It may not be Enter.** The scanner's suffix is Enter, so a button that
     * also sends Enter is indistinguishable from the end of a scan — the box
     * would see an empty code and a real scan would be swallowed by whatever
     * the button opened. The refinement below refuses it rather than leaving it
     * to be discovered at a counter.
     */
    buttonKey: z
      .string()
      .min(1)
      .max(24)
      .refine((k) => !/^(enter|return|numpadenter|\r|\n)$/i.test(k), {
        message: 'The USB button may not send Enter: the scanner already does',
      })
      .optional(),
  })
  .strict();
export type ScannerDeviceSettings = z.infer<typeof ScannerDeviceSettingsSchema>;

/**
 * The whole `core.device.settings` document.
 *
 * Sections rather than a union discriminated on `device.kind`, because the kind
 * lives in its own column and a document that repeated it could disagree with
 * it. The API picks the section that matches the device's kind and protocol and
 * ignores the rest; `.strict()` means a typo in a key is refused at the edit
 * rather than silently doing nothing on site.
 */
export const DeviceSettingsSchema = z
  .object({
    escpos: EscposDeviceSettingsSchema.optional(),
    label: LabelDeviceSettingsSchema.optional(),
    scanner: ScannerDeviceSettingsSchema.optional(),
  })
  .strict();
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;

/**
 * Which section a device kind reads. A kind that is absent here has no
 * per-unit settings today — a terminal's parameters come from the acquirer and
 * a gate's from its DIP switches, neither of which we set.
 */
export const SETTINGS_SECTION_FOR_KIND: Record<string, keyof DeviceSettings | undefined> = {
  receipt_printer: 'escpos',
  kitchen_printer: 'escpos',
  bar_printer: 'escpos',
  band_printer: 'label',
  scanner: 'scanner',
};
