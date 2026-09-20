# Vendored copy of `@oto/telemetry`

`redact.ts`, `scrub.ts` and `logger.ts` are **byte-for-byte copies** of
`packages/telemetry/src/` at the repository root. Do not edit them here.

## Why a copy at all

This app is excluded from the pnpm workspace (`pnpm-workspace.yaml`): it keeps
npm and its own lockfile, because inside the workspace pnpm would hoist its
dependency tree against the platform's and neither app would resolve what it
was written against. That exclusion is also what stops it importing
`@oto/telemetry` as a package — a workspace dependency needs the workspace.

The alternative to copying was a second, weaker redactor written for this app.
That is the outcome S2-03 spent a ticket undoing: three partial copies of the
rules had drifted apart, and a phone number that one of them caught went
straight through another. A phone number leaks in the app's log or it does
not; there is no version of that question this app gets to answer differently.

## How the two are kept in step

`check-sync.mjs` hashes these three files against
`packages/telemetry/src/` and fails if any of them differ. It runs from
`npm run check` and from `npm run build`, so a change made upstream and not
copied here — or an edit made here and not upstream — stops the build on the
machine that has both trees.

Inside the Docker image the platform sources are not in the build context, so
the check reports that it was skipped and the build continues. The guard that
matters is the one on a developer's machine and in CI, where both trees exist.

To take an upstream change:

    cp packages/telemetry/src/{redact,scrub,logger}.ts apps/oto-app/server/lib/telemetry/

Publishing `@oto/telemetry` to a registry, or building it to plain JS and
committing that here, both remove the copy. Neither is worth doing for three
files that change rarely; both become worth doing the moment a fourth lifted
app needs the same rules.
