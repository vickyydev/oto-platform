/// <reference types="vite/client" />

/**
 * Read at BUILD time — a static site has no server to read them at runtime — so
 * changing one is a rebuild of the Inbox, not a restart. Optional: unset, the
 * link it feeds is absent, which is better than a dead address.
 */
interface ImportMetaEnv {
  /** The suite's front door: where signing out lands, and "Back to the suite". */
  readonly VITE_LAUNCHER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
