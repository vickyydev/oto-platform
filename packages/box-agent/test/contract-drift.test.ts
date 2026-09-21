import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as box from '../src/contract';
import * as sharedStation from '../../shared/src/station-session';
import * as sharedSync from '../../shared/src/sync';
import { SUPPORTED_LANGS } from '../../shared/src/i18n/index';
import * as scan from '../src/scan';
import * as staffToken from '../src/staff-token';
import * as sharedScanning from '../../shared/src/scanning';
import * as sharedStaffToken from '../../shared/src/staff-token';

/**
 * The duplication in `src/contract.ts` is made safe here.
 *
 * `@oto/box-agent` cannot depend on `@oto/shared` until this package is
 * allowed a manifest change, so the sync contract exists twice. Two copies of
 * a wire format left to discipline diverge, and the way this one would
 * diverge is the expensive way: the canonical bytes are what both ends hash,
 * so a single reordered field would turn every honest re-send into a conflict
 * and fill the Failures tab with events that are perfectly fine.
 *
 * These are relative imports across a package boundary on purpose. They are
 * legal here and nowhere else: a test may reach for the thing it is checking
 * against, where the shipped code may not.
 */

test('the sync vocabularies match @oto/shared item for item', () => {
  assert.deepEqual([...box.SYNC_CLOCK_TRUST], [...sharedSync.SYNC_CLOCK_TRUST]);
  assert.deepEqual([...box.BUSINESS_DATE_SOURCES], [...sharedSync.BUSINESS_DATE_SOURCES]);
  assert.deepEqual([...box.SYNC_ACTOR_KINDS], [...sharedSync.SYNC_ACTOR_KINDS]);
  assert.deepEqual([...box.SYNC_SIG_ALGORITHMS], [...sharedSync.SYNC_SIG_ALGORITHMS]);
  assert.deepEqual([...box.SYNC_EVENT_RESULTS], [...sharedSync.SYNC_EVENT_RESULTS]);
  assert.deepEqual([...box.SYNC_QUARANTINE_REASONS], [...sharedSync.SYNC_QUARANTINE_REASONS]);
  assert.deepEqual([...box.SYNC_QUARANTINE_STATUSES], [...sharedSync.SYNC_QUARANTINE_STATUSES]);
  assert.deepEqual([...box.SYNC_ANOMALY_KINDS], [...sharedSync.SYNC_ANOMALY_KINDS]);
  assert.deepEqual([...box.SYNC_CHANGE_SCOPES], [...sharedSync.SYNC_CHANGE_SCOPES]);
  assert.deepEqual([...box.SYNC_CHANGE_OPS], [...sharedSync.SYNC_CHANGE_OPS]);
  assert.deepEqual([...box.SYNC_CANONICAL_FIELDS], [...sharedSync.SYNC_CANONICAL_FIELDS]);
  assert.equal(box.SYNC_EVENT_SCHEMA_VERSION, sharedSync.SYNC_EVENT_SCHEMA_VERSION);
  assert.equal(box.SYNC_PUSH_MAX_EVENTS, sharedSync.SYNC_PUSH_MAX_EVENTS);
  assert.equal(box.SYNC_PUSH_MAX_BYTES, sharedSync.SYNC_PUSH_MAX_BYTES);
  assert.equal(String(box.SYNC_EVENT_TYPE_PATTERN), String(sharedSync.SYNC_EVENT_TYPE_PATTERN));
  assert.equal(String(box.SYNC_PAYLOAD_HASH_PATTERN), String(sharedSync.SYNC_PAYLOAD_HASH_PATTERN));
});

test('the station session vocabularies match @oto/shared item for item', () => {
  assert.deepEqual([...box.STATION_SESSION_STAGES], [...sharedStation.STATION_SESSION_STAGES]);
  assert.deepEqual(
    [...box.STATION_LEASE_HOLDER_KINDS],
    [...sharedStation.STATION_LEASE_HOLDER_KINDS],
  );
  assert.deepEqual([...box.STATION_VIEWS], [...sharedStation.STATION_VIEWS]);
  assert.deepEqual([...box.STATION_INTENT_REFUSALS], [...sharedStation.STATION_INTENT_REFUSALS]);
  assert.deepEqual([...box.STATION_CHANNEL_MESSAGES], [...sharedStation.STATION_CHANNEL_MESSAGES]);
  assert.deepEqual([...box.STATION_LANGUAGES], [...SUPPORTED_LANGS]);
  assert.equal(box.STATION_SESSION_SCHEMA_VERSION, sharedStation.STATION_SESSION_SCHEMA_VERSION);
  assert.equal(box.STATION_LEASE_HEARTBEAT_S, sharedStation.STATION_LEASE_HEARTBEAT_S);
  assert.equal(box.STATION_LEASE_TTL_S, sharedStation.STATION_LEASE_TTL_S);
});

test('both ends canonicalise an envelope to exactly the same bytes', () => {
  const envelope = {
    eventId: '018f0000-0000-7000-8000-00000000e0e1',
    boxId: '018f0000-0000-7000-8000-00000000b0c5',
    journalEpoch: 3,
    boxSeq: 41,
    type: 'member.created',
    schemaVersion: 1,
    occurredAt: '2026-09-20T03:00:00.000Z',
    stationId: null,
    actorKind: 'account' as const,
    actorAccountId: null,
    actorCredentialId: null,
    actionId: 'act-1',
    // Deliberately out of alphabetical order and nested: key ordering is the
    // thing that would drift silently between two implementations.
    payload: { zeta: 1, alpha: { nested: [3, 2, 1], beta: null }, mid: 'x' },
  };

  assert.equal(box.canonicalSyncBytes(envelope), sharedSync.canonicalSyncBytes(envelope));

  // And the same envelope with its keys written in a different order hashes
  // the same, which is the property the whole dedupe rests on.
  const reordered = {
    payload: { mid: 'x', alpha: { beta: null, nested: [3, 2, 1] }, zeta: 1 },
    actionId: 'act-1',
    type: 'member.created',
    boxSeq: 41,
    journalEpoch: 3,
    boxId: envelope.boxId,
    eventId: envelope.eventId,
    schemaVersion: 1,
    occurredAt: envelope.occurredAt,
    stationId: null,
    actorKind: 'account' as const,
    actorAccountId: null,
    actorCredentialId: null,
  };
  assert.equal(box.canonicalSyncBytes(reordered), box.canonicalSyncBytes(envelope));

  // An absent field and an explicitly null one are the same event. A box that
  // stopped sending `actorCredentialId` after an upgrade must not turn every
  // re-send into a conflict.
  const { actorCredentialId: _dropped, ...withoutField } = envelope;
  assert.equal(box.canonicalSyncBytes(withoutField), box.canonicalSyncBytes(envelope));
});

test('a number that has no JSON form fails loudly rather than signing a null', () => {
  assert.throws(
    () => box.canonicalSyncBytes({ payload: { total: Number.POSITIVE_INFINITY } }),
    /non-finite/,
  );
  assert.throws(
    () => sharedSync.canonicalSyncBytes({ payload: { total: Number.POSITIVE_INFINITY } }),
    /non-finite/,
  );
});

// --- S2-06: scanning and the shift token ------------------------------------

test('the scan vocabularies match @oto/shared item for item', () => {
  assert.deepEqual([...scan.SCAN_SOURCES], [...sharedScanning.SCAN_SOURCES]);
  assert.deepEqual([...scan.SCAN_CODE_KINDS], [...sharedScanning.SCAN_CODE_KINDS]);
  assert.deepEqual([...scan.SCAN_OUTCOMES], [...sharedScanning.SCAN_OUTCOMES]);
  assert.equal(scan.SCAN_FINGERPRINT_LENGTH, sharedScanning.SCAN_FINGERPRINT_LENGTH);
});

test('a redacted scan payload is exactly what the shared schema accepts', () => {
  // The box writes this object by hand in `scan.ts`, and `@oto/shared` is what
  // the Console and any later reader parse it with. `.strict()` there means an
  // extra field is a refusal, so this is the assertion that a field added on
  // one side does not quietly start being dropped on the other.
  const payload = {
    source: 'box_hid',
    codeKind: 'band',
    codeFingerprint: scan.scanFingerprint('T1-01J8ZQ4F7K'),
    codeLength: 13,
    codePrefix: 'T1',
    outcome: 'handled',
    handler: 'bands',
    errorCode: 'SOMETHING',
    durationMs: 4,
  };
  assert.equal(sharedScanning.ScanEventPayloadSchema.safeParse(payload).success, true);
});

test('the staff token vocabularies match @oto/shared item for item', () => {
  assert.equal(staffToken.STAFF_TOKEN_SCHEMA_VERSION, sharedStaffToken.STAFF_TOKEN_SCHEMA_VERSION);
  assert.equal(staffToken.STAFF_TOKEN_ALGORITHM, sharedStaffToken.STAFF_TOKEN_ALGORITHM);
  assert.equal(
    staffToken.STAFF_OFFLINE_SIGN_IN_DAYS,
    sharedStaffToken.STAFF_OFFLINE_SIGN_IN_DAYS,
  );
  assert.deepEqual(
    { ...staffToken.STAFF_TOKEN_REFUSALS },
    { ...sharedStaffToken.STAFF_TOKEN_REFUSALS },
  );
});

test('the claims this package signs are exactly what the shared schema validates', () => {
  // The api mints with `encodeStaffToken` from this package and the shape is
  // declared in `@oto/shared`. If one grew a field the other did not, a token
  // would be minted that the platform's own schema refuses — and the place
  // that discovered it would be a locked till.
  const claims = {
    v: 1,
    jti: '018f0000-0000-7000-8000-00000000a0d1',
    sub: '018f0000-0000-7000-8000-0000000000a1',
    aud: '018f0000-0000-7000-8000-0000000000b2',
    sid: '018f0000-0000-7000-8000-0000000000e1',
    sta: '018f0000-0000-7000-8000-0000000057a1',
    box: '018f0000-0000-7000-8000-00000000b0c5',
    iat: 1_758_000_000,
    exp: 1_758_057_600,
  };
  assert.equal(sharedStaffToken.StaffTokenClaimsSchema.safeParse(claims).success, true);

  const denyList = { revokedAccountIds: [], revokedTokenIds: [claims.jti] };
  assert.equal(sharedStaffToken.StaffDenyListSchema.safeParse(denyList).success, true);
});
