import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';

/** SCRUM-523 / Q39: real authenticated scheduling requests in two park groups.
 * Every refusal checks the complete scheduling/history/duty database before
 * and after, including the owned first element of a mixed bulk request.
 * Same-park branch access and shared role definitions retain existing behavior.
 * FINDING pins state the required boundary and the prescribed implementation;
 * All 21 prescriptions are applied in source and their pins are now ordinary
 * tests. Runtime verification is still owed to the hosted release gate; no
 * local database run is claimed by this disposition.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let proof: Record<string, boolean>;

describe.skipIf(!available)('SCRUM-523 scheduling park boundary review', () => {
  afterAll(stopTestServer);
  beforeAll(async () => {
    const database = await createTestDatabase({ otoapp: true });
    try {
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), 'tests/scheduling-scope.check.ts'], {
        cwd: APP,
        env: { ...process.env, DATABASE_URL: database.url, DB_SCHEMA: 'otoapp', APP_ENV: 'dev', DEPLOY_ENV: 'local',
          OBJECT_STORAGE: 'local', STORAGE_ENV_PREFIX: 'zz-scheduling-review', OTOAPP_JOBS: 'platform', NODE_ENV: 'test',
          OTOAPP_LEGACY_LOGIN: 'true', USE_AWS_REKOGNITION: 'false', LOG_LEVEL: 'warn', TZ: 'UTC' },
        encoding: 'utf8', timeout: 280_000,
      });
      const output = (run.stdout ?? '') + (run.stderr ?? '');
      // Only allowlisted diagnostic fields are exposed. Child logs may contain
      // synthetic sign-in/session data and are deliberately never printed whole.
      const setup = /SCHEDULING_SETUP_ERROR=(.+)/.exec(output)?.[1];
      if (setup) console.info('Scheduling setup', setup);
      const details = /SCHEDULING_DETAILS=(.+)/.exec(output)?.[1];
      if (details) console.info('Scheduling request outcomes', details);
      expect(run.status, 'Scheduling child completes').toBe(0);
      const match = /SCHEDULING_RESULTS=(.+)/.exec(output);
      expect(match, 'Real-handler results recorded').toBeTruthy();
      proof = JSON.parse(match![1]!);
    } finally {
      await database.drop();
    }
  }, 420_000);

  it('owned week and saved-template controls return their actual records', () => expect(proof.ownedWeek && proof.ownedTemplate).toBe(true));
  it('a branch-limited manager retains existing other-branch read and edit inside the park', () => expect(proof.sameParkBranchDefault).toBe(true));
  it('shared role definitions retain Q54 while newly stored role links belong to the row park', () => expect(proof.sharedRoleDefault).toBe(true));
  it('owned history and repeated restore retain one original assignment', () => expect(proof.ownedHistory && proof.ownedRestoreReplay).toBe(true));
  it('owned duty creation records the expected assignment', () => expect(proof.ownedDuty).toBe(true));
  it('owned assignment batch retains partial-result replay behavior without duplicate assignments', () => expect(proof.ownedBatchReplay).toBe(true));
  it('assignment moves retain the existing restricted-branch refusal', () => expect(proof.existingMoveBranchRule).toBe(true));
  it('anonymous requests and unresolved park context reach no scheduling handler', () => expect(proof.anonymous && proof.missingContext).toBe(true));
  it('malformed parent arrays and repeated query parents fail before partial writes', () => expect(proof.malformedParents).toBe(true));
  it('reassignment retains exact existing foreign/missing assignment404 and employee400 responses without writes', () => expect(proof.reassignResponses).toBe(true));
  it('blank, null and whitespace group choices retain the existing400 reason and message without writes', () => expect(proof.groupRefusalResponses).toBe(true));
  it('FINDING 1 high: foreign reads including rota disclose no records; prescribed fix: validate every requested canonical parent park before reading', () => expect(proof.foreignReads).toBe(true));
  it('FINDING 2 high: foreign week/group/row writes change nothing; prescribed fix: resolved caller park preflight on every scheduling mutation', () => expect(proof.foreignWrites).toBe(true));
  it('FINDING 3 high: an owned row cannot take a foreign group; prescribed fix: check supplied parent IDs as well as target ownership', () => expect(proof.mixedParents).toBe(true));
  it('FINDING 4 high: mixed reorder changes neither first owned nor later foreign row; prescribed fix: validate the entire array before writes', () => expect(proof.mixedReorder).toBe(true));
  it('FINDING 5 high: merge preview and execute reject mixed parks; prescribed fix: validate every source and destination before lookup or merge', () => expect(proof.mixedMerge).toBe(true));
  it('FINDING 6 high: assignment parents and borrowed employees stay in one park; prescribed fix: validate week, row, employee and borrowed branch together', () => expect(proof.mixedAssignments).toBe(true));
  it('FINDING 7 high: mixed employee batch cannot leave its owned first assignment; prescribed fix: preflight all employee IDs before normal eligibility and writes', () => expect(proof.mixedBatch).toBe(true));
  it('FINDING 8 high: foreign move cannot write same-row metadata; prescribed fix: check source assignment and both row parents before move', () => expect(proof.foreignAssignmentMove).toBe(true));
  it('FINDING 9 high: repeated foreign reassign/delete remains unavailable; prescribed fix: enforce caller park before repeat/no-op branches', () => expect(proof.foreignReplay).toBe(true));
  it('FINDING 10 high: mixed conflict resolution writes neither park; prescribed fix: preflight every retained/deleted assignment and day-off ID', () => expect(proof.mixedConflictResolution).toBe(true));
  it('FINDING 11 high: foreign clear and destructive IDs preserve all records; prescribed fix: validate canonical target and branch before snapshot/delete', () => expect(proof.foreignClear && proof.foreignDestructive).toBe(true));
  it('FINDING 12 high: foreign break regeneration preserves stored breaks; prescribed fix: require caller-owned branch, week and shift plus scoped generator', () => expect(proof.foreignBreaks).toBe(true));
  it('FINDING 13 high: saved templates cannot read/write across either source or destination park; prescribed fix: validate template and all placement parents before any week creation', () => expect(proof.foreignTemplates).toBe(true));
  it('FINDING 14 high: history list and replayed restore use caller park; prescribed fix: replace default-park lookup and validate entry before restore', () => expect(proof.foreignHistoryList && proof.foreignHistoryRestore).toBe(true));
  it('FINDING 15 high: owned history containing foreign snapshot rows cannot remove live records; prescribed fix: preflight all snapshot IDs and references before restoration', () => expect(proof.mixedSnapshot).toBe(true));
  it('FINDING 16 high: alternate duty doors retain canonical park ownership; prescribed fix: validate branch, employee, assignment, type and existing block parents', () => expect(proof.foreignDuty).toBe(true));
  it('FINDING 17 high: owned lists omit historical mixed-parent rows and retain clean siblings; prescribed fix: scope every week, template and duty child join through canonical parents', () => expect(proof.historicalWeek && proof.historicalTemplate && proof.historicalDuty).toBe(true));
  it('FINDING 18 high: break regeneration excludes mixed-parent assignments and retains owned breaks; prescribed fix: scope generator assignments through employee and shift parents', () => expect(proof.historicalBreaks).toBe(true));
  it('FINDING 19 high: snapshot role-link IDs cannot collide with another park; prescribed fix: validate existing link ownership before deleting any current rows', () => expect(proof.snapshotLinkCollision).toBe(true));
  it('FINDING 20 high: interrupted restore retains all current assignments and breaks; prescribed fix: transactionally replace the complete snapshot with rollback on any insert failure', () => expect(proof.restoreRollback).toBe(true));
  it('FINDING 21 high: owned parent deletion and restore cannot cascade into foreign children; prescribed fix: validate all incoming FK descendants before destructive operations', () => expect(proof.incomingForeignChildren).toBe(true));
});
