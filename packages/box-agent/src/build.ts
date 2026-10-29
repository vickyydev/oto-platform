import { BOX_AGENT_VERSION } from './protocol';

/**
 * Which build of the agent this is — the name a release goes by everywhere.
 *
 * A packed release is identified by one string, its BUILD ID:
 *
 *   <version>-<YYYYMMDD>-<commit>        0.1.0-20261029-b25b644
 *
 * The version is `BOX_AGENT_VERSION`, what the cloud compares against its
 * minimum; the date (the build's UTC day) and the short commit say WHICH
 * build of that version. The same string names the tarball
 * (`oto-box-<build id>.tgz`), the release folder on a Pi
 * (`/opt/oto-box/releases/<build id>`), the first line of the release's
 * `VERSION` file, what `oto-box status` and `oto-box version` print, and the
 * `agentVersion` the box reports on every heartbeat — so the Console names
 * the exact build running on each box.
 *
 * `scripts/build-runner.mjs` bakes the id and the build time into the bundle
 * with esbuild's `define`, so a bundle knows its own build without reading a
 * file beside itself. Run from source — the tests, the virtual box inside the
 * api — neither is set, and the build is the bare version.
 */
export interface BoxBuild {
  /** `0.1.0-20261029-b25b644`; the bare version when not a packed release. */
  id: string;
  /** `0.1.0` — `BOX_AGENT_VERSION` as it was when this was built. */
  version: string;
  /** `2026-10-29`, the build's UTC day; null off a source run. */
  date: string | null;
  /** The short commit, `+local` when the tree was dirty; null off a source run. */
  commit: string | null;
  /** The full ISO build time; null off a source run. */
  builtAt: string | null;
}

const BUILD_ID = /^(\d+\.\d+\.\d+)-(\d{4})(\d{2})(\d{2})-([A-Za-z0-9.+]+)$/;

/** Read a build id apart; an id that is not one is a bare version. */
export function parseBuildId(id: string, builtAt: string | null = null): BoxBuild {
  const m = BUILD_ID.exec(id);
  if (!m) return { id, version: id, date: null, commit: null, builtAt };
  const [, version, year, month, day, commit] = m as unknown as [string, string, string, string, string, string];
  return { id, version, date: `${year}-${month}-${day}`, commit, builtAt };
}

/**
 * One readable line: `oto-box 0.1.0 build 2026-10-29 b25b644 (2026-10-29T05:38:23Z)`,
 * or `oto-box 0.1.0 (run from source, not a packed release)`.
 */
export function describeBuild(build: BoxBuild = BOX_AGENT_BUILD): string {
  if (build.date === null || build.commit === null) {
    return `oto-box ${build.version} (run from source, not a packed release)`;
  }
  const when = build.builtAt ? ` (${build.builtAt})` : '';
  return `oto-box ${build.version} build ${build.date} ${build.commit}${when}`;
}

/** This process's build. The packer defines both values; from source they are unset. */
export const BOX_AGENT_BUILD: BoxBuild = parseBuildId(
  process.env.OTO_BOX_BUILD_ID || BOX_AGENT_VERSION,
  process.env.OTO_BOX_BUILT_AT || null,
);
