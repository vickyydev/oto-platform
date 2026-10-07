/**
 * Staff benefits for the demo tenant (S2-21, SCRUM-218, rounds 1 and 4 of
 * docs/progress/plans/benefits/PLAN.md).
 *
 * The prototype's three role templates (`seedRoleBenefitTemplates`,
 * catalogStore.ts:802-841) at its own amounts — plan Q2's default — and the
 * prototype roster's benefit roles (`mockOperators`, mockApi.ts:430-435) on
 * the seeded employees of the same names:
 *
 *   Owner    comp
 *   Manager  2 free coffees a day, ฿500 a month credit, 30 % off F&B
 *   Staff    2 free coffees a day, 30 % off F&B
 *
 *   Khun Anan  owner      Som  staff      Khun Lek  manager
 *   Nok        staff, with an override: the Staff template with 4 coffees a
 *              day (the plan's named fixture, §6 row 1)
 *
 * Round 4 adds the two fixtures the plan's seed names beside them (§8):
 *
 *   - ONE MANAGER EDIT DATED IN THE FUTURE: the Manager's credit at ฿600 a
 *     month from the first day of the month after next (Q2's acceptance
 *     figure), so Admin > Staff Benefits shows a scheduled change and its
 *     history from the first sign-in. The month after next, never next month,
 *     so it can never fall on "tomorrow" — the day the acceptance edit uses.
 *   - THE FOUR EMPLOYEES' BENEFIT QRs, when the seed is given the deployment's
 *     `BENEFIT_QR_PRIVATE_KEY` (`seedBenefitCredentials`): one credential each,
 *     signed exactly as `POST /benefits/credentials` signs one, so the QR the
 *     Staff Benefits dialog prints scans in the scanner simulator. Without the
 *     key nothing is issued (a QR no key verifies would scan nowhere) and the
 *     seed says so.
 *
 * Khun Dao (Robinson Chalong) is not in the prototype's roster and is given
 * no benefit role, which is the prototype's "no role, no benefit".
 *
 * "Coffee" is the prototype's `drinks-coffee` category, which the menu seed
 * writes as `DRINKS-COFFEE`; the templates point at that row's id.
 *
 * CONVERGENT. Find-or-create throughout: a template role or a person that
 * already has ANY version is left alone, the future Manager edit is written
 * only beside the untouched seeded Manager version, and a person who has ever
 * held a benefit QR (live, revoked or expired) is issued none — so a change
 * made on screen survives a re-seed, and a re-seed writes nothing new.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  BENEFIT_CREDENTIAL_KEY_PURPOSE,
  BENEFIT_CREDENTIAL_TTL_DAYS,
  BENEFIT_CREDENTIAL_VERSION,
  BENEFIT_ROLE_NAMES,
  benefitCredentialSigningInput,
  newId,
  satangFromBaht,
  type BenefitProfile,
  type BenefitRole,
} from '@oto/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';

/** The day the seeded versions are in force from: before any demo trading day. */
export const BENEFIT_SEED_EFFECTIVE_FROM = '2026-01-01';

/** The Manager's credit in the seeded future edit: the acceptance's ฿600 (plan Q2's default). */
export const BENEFIT_SEED_FUTURE_CREDIT_SATANG = satangFromBaht(600);

/**
 * The day the seeded future Manager edit counts from: the first day of the
 * month after next, from the trading day the seed runs on.
 */
export function benefitSeedFutureFrom(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const months = y * 12 + (m - 1) + 2;
  return `${Math.floor(months / 12)}-${String((months % 12) + 1).padStart(2, '0')}-01`;
}

/** The prototype's three templates, the free coffee pointed at `coffeeCategoryId`. */
export function seedBenefitTemplates(
  coffeeCategoryId: string,
): Record<BenefitRole, BenefitProfile> {
  const coffee = {
    id: 'coffee',
    label: 'Free coffee',
    target: { kind: 'fnbCategory' as const, category: coffeeCategoryId },
    quotaPerPeriod: 2,
    period: 'daily' as const,
  };
  return {
    owner: { comp: true },
    manager: {
      freeItems: [coffee],
      credit: { amountSatang: satangFromBaht(500), period: 'monthly' },
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    },
    staff: {
      freeItems: [coffee],
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    },
  };
}

export async function seedBenefits(
  db: Db,
  input: {
    operatorId: string;
    /** Employee ids by the prototype roster's names. */
    employees: { anan: string; som: string; nok: string; lek: string };
    /** The trading day the seed runs on, at the demo park: the future edit is dated from it. */
    today: string;
  },
): Promise<void> {
  const [coffeeCategory] = await db
    .select({ id: s.productCategory.id })
    .from(s.productCategory)
    .where(
      and(
        eq(s.productCategory.operatorId, input.operatorId),
        eq(s.productCategory.code, 'DRINKS-COFFEE'),
      ),
    )
    .limit(1);
  if (!coffeeCategory) {
    throw new Error('Benefits seed: the menu seed did not write the DRINKS-COFFEE category');
  }
  const templates = seedBenefitTemplates(coffeeCategory.id);

  for (const role of ['owner', 'manager', 'staff'] as const) {
    const [held] = await db
      .select({ id: s.benefitRoleTemplate.id })
      .from(s.benefitRoleTemplate)
      .where(
        and(
          eq(s.benefitRoleTemplate.operatorId, input.operatorId),
          eq(s.benefitRoleTemplate.role, role),
        ),
      )
      .limit(1);
    if (held) continue;
    await db.insert(s.benefitRoleTemplate).values({
      id: newId(),
      operatorId: input.operatorId,
      role,
      name: BENEFIT_ROLE_NAMES[role],
      profile: templates[role],
      effectiveFrom: BENEFIT_SEED_EFFECTIVE_FROM,
    });
  }

  await seedFutureManagerEdit(db, input.operatorId, templates.manager, input.today);

  // Nok's override: the Staff template, filled in as the override dialog
  // fills it, with the coffee quota raised to four.
  const nokOverride: BenefitProfile = {
    ...templates.staff,
    freeItems: (templates.staff.freeItems ?? []).map((f) => ({ ...f, quotaPerPeriod: 4 })),
  };
  const people: Array<{ employeeId: string; role: BenefitRole; override: BenefitProfile | null }> =
    [
      { employeeId: input.employees.anan, role: 'owner', override: null },
      { employeeId: input.employees.som, role: 'staff', override: null },
      { employeeId: input.employees.nok, role: 'staff', override: nokOverride },
      { employeeId: input.employees.lek, role: 'manager', override: null },
    ];
  for (const person of people) {
    const [held] = await db
      .select({ id: s.benefitProfile.id })
      .from(s.benefitProfile)
      .where(eq(s.benefitProfile.employeeId, person.employeeId))
      .limit(1);
    if (held) continue;
    await db.insert(s.benefitProfile).values({
      id: newId(),
      operatorId: input.operatorId,
      employeeId: person.employeeId,
      benefitRole: person.role,
      override: person.override,
      effectiveFrom: BENEFIT_SEED_EFFECTIVE_FROM,
    });
  }
}

/**
 * The Manager's credit at ฿600 from the month after next, written the way the
 * benefits service writes a change dated in the future (`writeVersion`): the
 * version in force that day is closed on it and the new one runs on. Only
 * beside the seeded Manager version standing alone and untouched — one row,
 * the seed's own, open-ended — so a template somebody has since changed, or a
 * re-seed, writes nothing.
 */
async function seedFutureManagerEdit(
  db: Db,
  operatorId: string,
  manager: BenefitProfile,
  today: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(s.benefitRoleTemplate)
    .where(and(eq(s.benefitRoleTemplate.operatorId, operatorId), eq(s.benefitRoleTemplate.role, 'manager')));
  const [seeded] = rows;
  if (
    rows.length !== 1 ||
    !seeded ||
    seeded.createdByAccountId !== null ||
    seeded.effectiveFrom !== BENEFIT_SEED_EFFECTIVE_FROM ||
    seeded.effectiveTo !== null
  ) {
    return;
  }
  const from = benefitSeedFutureFrom(today);
  await db.transaction(async (tx) => {
    await tx
      .update(s.benefitRoleTemplate)
      .set({ effectiveTo: from, updatedAt: new Date() })
      .where(eq(s.benefitRoleTemplate.id, seeded.id));
    await tx.insert(s.benefitRoleTemplate).values({
      id: newId(),
      operatorId,
      role: 'manager',
      name: BENEFIT_ROLE_NAMES.manager,
      profile: {
        ...manager,
        credit: { ...manager.credit!, amountSatang: BENEFIT_SEED_FUTURE_CREDIT_SATANG },
      },
      effectiveFrom: from,
    });
  });
}

// --- The benefit QRs (round 4) ------------------------------------------------------

/**
 * The deployment's benefit QR key, read as the api reads `BENEFIT_QR_PRIVATE_KEY`
 * (`parseStaffTokenKey` and `staffTokenKid` in apps/api/src/lib): a PEM, the
 * same with its newlines escaped, or base64 of it; the `kid` is the first
 * sixteen hex characters of SHA-256 over the public half's DER. Repeated here
 * because the database package cannot import the api; the seed test holds the
 * two to one answer by resolving a seeded QR through the api.
 */
export function benefitQrKeyOf(raw: string): { privateKeyPem: string; publicKeyPem: string; kid: string } {
  let text = raw.trim();
  if (!text.includes('BEGIN')) {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) text = decoded.trim();
  }
  text = text.replace(/\\n/g, '\n');
  const privateKey = createPrivateKey(text);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('BENEFIT_QR_PRIVATE_KEY is not an ed25519 key');
  }
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    kid: createHash('sha256').update(der).digest('hex').slice(0, 16),
  };
}

/**
 * Issue the four seeded employees' benefit QRs: the public half published as a
 * `core.signing_key` row (purpose `benefit_qr`) as the api publishes it, then
 * one credential per person who has a benefit role and has never held one,
 * issued by the demo administrator, good for the api's own lifetime. The row
 * keeps the code's hash and never the code; the Staff Benefits dialog prints
 * the code again from the row and the key, as it does for any QR.
 *
 * Returns how many were issued.
 */
export async function seedBenefitCredentials(
  db: Db,
  input: {
    operatorId: string;
    issuedByAccountId: string;
    employees: { anan: string; som: string; nok: string; lek: string };
    privateKey: string;
    now?: Date;
  },
): Promise<number> {
  const key = benefitQrKeyOf(input.privateKey);
  const now = input.now ?? new Date();
  await db
    .insert(s.signingKey)
    .values({
      id: newId(),
      operatorId: null,
      purpose: BENEFIT_CREDENTIAL_KEY_PURPOSE,
      kid: key.kid,
      algorithm: 'ed25519',
      publicKey: key.publicKeyPem,
      active: true,
    })
    .onConflictDoNothing({ target: [s.signingKey.purpose, s.signingKey.kid] });

  let issued = 0;
  for (const employeeId of [input.employees.anan, input.employees.som, input.employees.nok, input.employees.lek]) {
    const [held] = await db
      .select({ id: s.benefitCredential.id })
      .from(s.benefitCredential)
      .where(eq(s.benefitCredential.employeeId, employeeId))
      .limit(1);
    if (held) continue;
    const [role] = await db
      .select({ role: s.benefitProfile.benefitRole })
      .from(s.benefitProfile)
      .where(and(eq(s.benefitProfile.employeeId, employeeId), isNotNull(s.benefitProfile.benefitRole)))
      .limit(1);
    // The prototype's rule: no benefit role, no QR.
    if (!role?.role) continue;
    const id = newId();
    const exp = Math.floor(now.getTime() / 1000) + BENEFIT_CREDENTIAL_TTL_DAYS * 86_400;
    const signingInput = benefitCredentialSigningInput({ employeeId, credentialId: id, exp, kid: key.kid });
    const signature = sign(null, Buffer.from(signingInput, 'ascii'), key.privateKeyPem);
    const code = `${signingInput}.${signature.toString('base64url')}`;
    await db.insert(s.benefitCredential).values({
      id,
      operatorId: input.operatorId,
      employeeId,
      kid: key.kid,
      version: BENEFIT_CREDENTIAL_VERSION,
      codeHash: createHash('sha256').update(code, 'utf8').digest('hex'),
      issuedByAccountId: input.issuedByAccountId,
      issuedAt: now,
      expiresAt: new Date(exp * 1000),
    });
    issued += 1;
  }
  return issued;
}
