/// <reference types="vite/client" />

/**
 * The build-time switches this app reads. Declared so they are `string |
 * undefined` rather than `any` — a typo in an env name then fails a typecheck
 * instead of quietly selecting the wrong transport.
 */
interface ImportMetaEnv {
  /** `1` forces the built-in fake, `0` forces HTTP. Unset: fake in dev, HTTP in a build. */
  readonly VITE_BOOTH_FAKE?: string;
  /** Where the booth service answers. Default `/booth`. */
  readonly VITE_BOOTH_API?: string;
  /**
   * The single PIN the FAKE accepts. Unset, the fake takes any four digits or
   * more. It is not a credential and never reaches a real booth — see the note
   * on `FakeBooth.signIn`.
   */
  readonly VITE_BOOTH_FAKE_PIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
