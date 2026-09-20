/**
 * One place that turns a fixture into its three artefacts, used by both the
 * writer script and the test that checks the committed files still match.
 *
 * The test page prints the device it came off, so its data is overridden per
 * profile rather than repeated nine times in the fixture list.
 */

import { renderJob, layoutSummary, previewPng, RENDERER_VERSION } from '../src/index';
import type { PrintJob, RenderedJob } from '../src/index';
import { FIXTURES, PROFILES, TEMPLATES } from './fixtures';
import type { Fixture } from './fixtures';

export interface FixtureArtefacts {
  key: string;
  job: RenderedJob;
  png: Uint8Array;
  layout: string;
}

export function fixtureJob(fixture: Fixture, profileKey: string): PrintJob {
  const device = PROFILES[profileKey];
  if (!device) throw new Error(`unknown device profile ${profileKey}`);
  if (fixture.job.kind !== 'test_page') return fixture.job;
  return {
    kind: 'test_page',
    data: {
      ...fixture.job.data,
      deviceLabel: device.label,
      model: device.model,
      widthDots: device.widthDots,
      rendererVersion: RENDERER_VERSION,
      address: device.language === 'tspl2' ? '192.168.88.204:9100' : '192.168.88.202:9100',
      transport: 'TCP 9100, one session',
    },
  };
}

export function buildFixture(fixture: Fixture, profileKey: string): FixtureArtefacts {
  const device = PROFILES[profileKey];
  if (!device) throw new Error(`unknown device profile ${profileKey}`);
  const job = renderJob(fixtureJob(fixture, profileKey), { device, templates: TEMPLATES });
  return {
    key: `${fixture.name}.${profileKey}`,
    job,
    png: previewPng(job.bitmap),
    layout: JSON.stringify(layoutSummary(job.layout), null, 2) + '\n',
  };
}

/** Every fixture on every profile it names, in a stable order. */
export function allFixtures(): FixtureArtefacts[] {
  const out: FixtureArtefacts[] = [];
  for (const fixture of FIXTURES) {
    for (const profile of fixture.profiles) out.push(buildFixture(fixture, profile));
  }
  return out;
}
