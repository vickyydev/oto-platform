/// <reference types="vite/client" />

/**
 * Read at BUILD time — a static site has no server to read them at runtime — so
 * changing one is a rebuild of the console, not a restart. Each is optional:
 * unset, the link it feeds is simply absent, which is better than a dead
 * address on a page people open when something is already wrong.
 */
interface ImportMetaEnv {
  /** The suite's front door, for the "Back to the suite" link in the header. */
  readonly VITE_LAUNCHER_URL?: string;
  /**
   * The till's origin. Its `/admin` holds the Sprint 1 back-office panels —
   * catalogue, tax, members, accounts — which stay there this sprint, so the
   * console links to them rather than pretending to own them.
   */
  readonly VITE_POS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
