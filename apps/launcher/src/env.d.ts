/// <reference types="vite/client" />

/**
 * Where each app of the suite is deployed. Read at BUILD time — a static site
 * has no server to read them at runtime — so changing one is a rebuild of the
 * launcher, not a restart. An unset or unparseable value leaves that tile
 * pointing at its own "coming soon" shell rather than at a dead address.
 */
interface ImportMetaEnv {
  readonly VITE_POS_URL?: string;
  readonly VITE_CONSOLE_URL?: string;
  readonly VITE_OTO_APP_URL?: string;
  readonly VITE_RADAR_URL?: string;
  readonly VITE_BOOTH_URL?: string;
  readonly VITE_INBOX_URL?: string;
  /** The systems still running today, linked from the "coming soon" shells. */
  readonly VITE_OTO_APP_LEGACY_URL?: string;
  readonly VITE_RADAR_LEGACY_URL?: string;
  readonly VITE_BOOTH_LEGACY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
