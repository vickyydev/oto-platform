import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_PROOF_EXPIRY_PROBLEMS, TIER_PROOF_OTHER } from '@oto/shared';
import { TIER_PROOF_TYPES } from '../src/lifted/lib/tierProof';
import { tierDocumentProblem } from '../src/lifted/components/admin/members/MemberFormDialog';

/**
 * SCRUM-1053 — THE CONSOLE'S MEMBER FORM ASKS FOR A RATE DOCUMENT'S EXPIRY
 * DATE BY THE TILL'S RULE (SCRUM-1019, the owner's answer of 19 November:
 * required on every kind, Other included; the Thai rate names no document).
 * The platform already refuses a document with no date
 * (`POST /members/:id/tier-verification`, TIER_PROOF_EXPIRY); the form now
 * says so before saving instead of after the round trip.
 */

const TODAY = '2026-11-19';
const options = { noDocument: false, proofTypes: TIER_PROOF_TYPES, today: TODAY };

describe('SCRUM-1053 — a rate document recorded in the Console', () => {
  it('needs its expiry date on every kind the form offers, and on Other where it is offered', () => {
    const withOther = { ...options, proofTypes: [...TIER_PROOF_TYPES, TIER_PROOF_OTHER] };
    for (const proofType of withOther.proofTypes) {
      expect(tierDocumentProblem({ proofType, expiresAt: '' }, withOther), proofType).toBe(TIER_PROOF_EXPIRY_PROBLEMS.missing);
      expect(tierDocumentProblem({ proofType, expiresAt: '2027-03-31' }, withOther), proofType).toBeNull();
    }
  });

  it('refuses a date that is not a date, and a document already expired', () => {
    expect(tierDocumentProblem({ proofType: TIER_PROOF_TYPES[0]!, expiresAt: '2027-02-30' }, options)).toBe(TIER_PROOF_EXPIRY_PROBLEMS.notADate);
    expect(tierDocumentProblem({ proofType: TIER_PROOF_TYPES[0]!, expiresAt: '2026-11-18' }, options)).toMatch(/already expired/);
    expect(tierDocumentProblem({ proofType: TIER_PROOF_TYPES[0]!, expiresAt: TODAY }, options)).toBeNull();
  });

  it('asks for the document first, and nothing of the Thai rate, which names no document', () => {
    expect(tierDocumentProblem({ proofType: '', expiresAt: '' }, options)).toBe('Select the document you checked.');
    expect(tierDocumentProblem({ proofType: '', expiresAt: '' }, { ...options, noDocument: true })).toBeNull();
  });

  it('the form checks it before saving, only when the document changes', () => {
    const form = readFileSync(path.resolve(import.meta.dirname, '../src/lifted/components/admin/members/MemberFormDialog.tsx'), 'utf8');
    expect(form).toMatch(/if \(tierChanged\) \{[\s\S]{0,300}?const documentProblem = tierDocumentProblem\(selection, \{ noDocument, proofTypes, today: todayIso\(\) \}\);\s*if \(documentProblem\) nextErrors\.tier = documentProblem;/);
  });
});
