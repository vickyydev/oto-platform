/**
 * Permission constants (CLAUDE.md §3): `service:resource:action` strings.
 * Roles are named bundles; a role assignment binds an account to a role with a
 * scope (operator / branch / department / record). Seed roles are generated
 * from these lists (packages/db/seed).
 *
 * The vocabulary is declared ahead of the features that enforce it (S2-01b):
 * a permission added on the day its route is written cannot be granted to
 * anyone until the next sync, and the roles would drift apart between
 * environments in the meantime.
 */

export const PERMISSIONS = [
  // Admin console — accounts & access
  'admin:account:create',
  'admin:account:read',
  'admin:account:update',
  'admin:role:read',
  'admin:role:assign',
  'admin:operator:create',
  'admin:operator:read',
  'admin:operator:update',
  /**
   * The marker for "administers the WHOLE operator" (SCRUM-318).
   *
   * It guards no route. It exists to be asked about: several places have to
   * decide whether an account's reach is the entire operator rather than one
   * park — provisioning into the OTO App seats such a person at every mapped
   * branch — and the alternatives were both wrong. Asking by ROLE NAME reads an
   * operator's own custom role literally named `operator_admin` as the system
   * one, because role names are unique per operator and nothing stops an
   * operator minting that name. Asking by some other permission held at
   * operator scope (`admin:role:assign`, say) answers a different question and
   * drags every role that happens to carry it along.
   *
   * Carried by `platform_admin` and `operator_admin` because both take the
   * whole vocabulary; deliberately absent from `branch_manager` and below. A
   * custom role may carry it — that is a deliberate grant, which is the point.
   */
  'admin:operator:all',
  'admin:branch:create',
  'admin:branch:read',
  'admin:branch:update',
  'admin:audit:read',
  /** Unmasked audit: child health notes, phones, terminal payloads (S2-03). */
  'admin:audit:read_sensitive',
  // Admin console — the fleet: stations, the boxes that run them, the devices
  // bolted to each box (S2-04)
  'admin:station:read',
  'admin:station:create',
  'admin:station:update',
  'admin:station:archive',
  'admin:box:read',
  'admin:box:register',
  'admin:box:update',
  /** Test print, restart, collect logs, go offline, reset store. */
  'admin:box:command',
  'admin:box:archive',
  'admin:device:read',
  'admin:device:create',
  'admin:device:update',
  'admin:device:archive',
  /** Mint a pairing code for a display, kiosk or booth. */
  'admin:device:pair',
  'admin:device:revoke',
  // Admin console — the Lucky Wheel booths (S2-07b)
  'admin:booth:read',
  'admin:booth:manage',
  /** Publish a config version the booths then pull. */
  'admin:booth:publish',
  'admin:booth:staff_assign',
  /**
   * Sign in AT a booth as the person attending it (SCRUM-223).
   *
   * Not an `admin:booth:*` permission: those configure a booth from the
   * Console, and this is the act of standing at one. It is the role half of a
   * two-part rule — an account signs in at a booth only when its role carries
   * this AND an administrator has put it on that booth's staff list
   * (`booth.booth_staff_assignment`). Checked by the cloud when somebody signs
   * in with their phone and password; a booth PIN was already confined to the
   * booth's list.
   *
   * Carried by every counter role, `staff` included: `staff` already opens the
   * booth app (`app:booth:access`), and which booth anybody may work is the
   * assignment's decision, not the role's.
   */
  'booth:staff:sign_in',
  // Admin console — running the platform (S2-03)
  'admin:health:read',
  /** Retry a failed run, acknowledge an alert, resolve an expectation. */
  'admin:ops:manage',
  // POS — members & visits
  'pos:member:read',
  /**
   * Browsing the register, which is a different act from identifying the
   * visitor at the counter (SCRUM-246).
   *
   * `pos:member:read` answers "who is this phone number" — one member, the one
   * standing there, and reception needs it every few minutes. This one answers
   * "who are all the members", which is the park's whole customer list and
   * every guardian's phone number in one response. Reception never needs that,
   * so it is not in their bundle: a till left unlocked, shared between shifts
   * or signed in by somebody who should not be cannot page through the
   * register.
   */
  'pos:member:list',
  'pos:member:create',
  'pos:member:update',
  /** Manager gate: a tier only ever goes down with someone accountable for it. */
  'pos:member:tier_downgrade',
  'pos:child:read',
  'pos:child:create',
  'pos:child:update',
  'pos:visit:create',
  'pos:visit:read',
  'pos:visit:update',
  // POS — bookings made online, claimed at a counter (SCRUM-306)
  /**
   * The redeem screen's waiting list: who paid on the booking site and is
   * expected at this branch.
   *
   * Its own permission rather than the `pos:visit:read` the routes borrowed
   * while no `pos:booking:*` existed to grant. A booking is not yet a visit,
   * and the list is not the same thing to hold: it carries the name and phone
   * of every family arriving, member or not, which is why it sits beside
   * `pos:member:list` in what it exposes rather than beside a single lookup.
   */
  'pos:booking:read',
  /**
   * Claiming one at the counter — once, on a payment taken somewhere else.
   *
   * Borrowed `pos:voucher:redeem` until this ticket. A voucher handed over the
   * counter and a family arriving on an online booking are different acts, and
   * while the two shared a permission no role could carry one without the
   * other.
   */
  'pos:booking:redeem',
  /**
   * Manager gate: taking a LIVE station away from the till holding it (S2-05).
   *
   * Not an `admin:station:*` permission, because it is not estate
   * configuration — it happens at a counter, mid-sale, and what it costs is
   * somebody's half-finished order. An expired lease needs none of this: it is
   * claimable by anyone after the TTL, which is what makes a closed browser
   * tab something reception can recover from without finding a manager.
   */
  'pos:station:takeover',
  // POS — selling (S2-09 … S2-11)
  'pos:sale:read',
  'pos:sale:create',
  'pos:sale:update',
  /** A manual discount, which always carries a reason. */
  'pos:sale:discount',
  'pos:sale:void',
  'pos:payment:read',
  'pos:payment:capture',
  /** Confirm an attempt the terminal or gateway left unresolved. */
  'pos:payment:confirm',
  'pos:payment:void',
  'pos:payment:settle',
  'pos:refund:read',
  'pos:refund:create',
  /** Manager gate on refunds and on voids after payment. */
  'pos:refund:approve',
  'pos:voucher:redeem',
  'pos:print:read',
  'pos:print:receipt',
  'pos:print:band',
  'pos:print:voucher',
  /** A reprint keeps the original code, so it is staff-only. */
  'pos:print:reprint',
  // POS — the drawer and the day's close (S2-15a)
  'pos:cash:read',
  'pos:cash:session_open',
  'pos:cash:session_close',
  /** Paid-in, paid-out, safe drop. */
  'pos:cash:movement',
  /** Countersign a paid-out, a safe drop or a close variance. */
  'pos:cash:approve',
  'pos:cash:day_close',
  // POS — child supervision (S2-13)
  'pos:checkin:read',
  'pos:checkin:create',
  'pos:checkin:update',
  'pos:checkin:release',
  'pos:checkin:guardian_manage',
  // POS — wallets (S2-14a)
  'pos:wallet:read',
  'pos:wallet:grant',
  'pos:wallet:spend',
  'pos:wallet:adjust',
  /** Manager gate: bringing expired credit back needs a typed reason. */
  'pos:wallet:reactivate',
  // POS — stock (S2-14b)
  'pos:stock:read',
  'pos:stock:adjust',
  'pos:stock:transfer',
  'pos:stock:count',
  /**
   * S2-14b (OD-S4, rule R-76) — take a delivery onto a shelf, ad hoc or
   * against a purchase order line. Split from `order` because every member of
   * staff receives stock and only a manager raises an order.
   */
  'pos:stock:receive',
  /** Purchase orders: raise and receive. */
  'pos:stock:order',
  /** Manager gate on a stock-take variance above the branch's tolerance. */
  'pos:stock:approve',
  // Branch catalog
  'catalog:package:read',
  'catalog:package:create',
  'catalog:package:update',
  'catalog:holiday:read',
  'catalog:holiday:manage',
  'catalog:tax:read',
  'catalog:tax:manage',
  /**
   * The menu, the shop and the discount codes (SCRUM-232, SCRUM-204).
   *
   * `import` is separate from `manage` on purpose: correcting one price and
   * replacing eighty items in a single click are different risks, and the
   * second one arrives as a file from outside the system. Reading is in the
   * counter's bundle because the till cannot sell what it cannot list.
   */
  'catalog:menu:read',
  'catalog:menu:manage',
  'catalog:menu:import',
  // Staff benefits (S2-21, SCRUM-218; plan docs/progress/plans/benefits/PLAN.md)
  /**
   * Apply a colleague's benefit at the F&B order station. Every counter role
   * holds it: the prototype lets whoever is signed in at the till scan a
   * benefit QR, their own included (plan Q9).
   */
  'pos:benefit:apply',
  /** The Staff Benefits screen: the role templates, who has which, and their history. */
  'admin:benefit:read',
  /** Edit a role template, assign a benefit role, set or clear a person's override. */
  'admin:benefit:manage',
  /** Issue, revoke and print a staff member's benefit QR (round 2). */
  'admin:benefit:credential_issue',
  // Analytics — the rollups Radar and Today read (S2-18)
  'analytics:read',
  // Which of the suite's apps a person may open (S2-02). Access is separate
  // from what they may do once inside: a nanny with POS permissions still has
  // no business on the console.
  'app:pos:access',
  'app:console:access',
  'app:oto_app:access',
  'app:radar:access',
  'app:booth:access',
  'app:inbox:access',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type ScopeType = 'operator' | 'branch' | 'department' | 'record';

export const SYSTEM_ROLES = [
  'platform_admin',
  'operator_admin',
  'branch_manager',
  'reception',
  'staff',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

const ALL = [...PERMISSIONS];

const READ_CATALOG: Permission[] = [
  'catalog:package:read',
  'catalog:holiday:read',
  'catalog:tax:read',
  'catalog:menu:read',
];

/**
 * What the till reads without being allowed to change it. Every counter role
 * holds these, so the read-only bundle is the floor the others build on.
 */
const READ_COUNTER: Permission[] = [
  'admin:branch:read',
  /**
   * `admin:station:read` is deliberately NOT here (S2-04 review).
   *
   * It reads like a counter permission and is not one: it opens the admin
   * station list, which carries who may use each station, its code prefix, the
   * LAN address of every printer on it and its payment routing. With it in this
   * bundle every staff account held it, so the ticket's own rule — somebody who
   * cannot use a station should not be looking at it — was defeated by one
   * request to `GET /branches/:id/stations`. What the counter actually needs is
   * `GET /me/stations`, which takes no permission at all and filters on the
   * access scope. This belongs to whoever configures the estate.
   */
  'pos:member:read',
  'pos:child:read',
  'pos:visit:read',
  'pos:sale:read',
  'pos:payment:read',
  'pos:refund:read',
  'pos:print:read',
  'pos:checkin:read',
  'pos:wallet:read',
  'pos:stock:read',
  /**
   * S2-15a — the End of Day on the Today screen, which every counter role
   * opens: the prototype lets any signed-in staff member run it.
   */
  'pos:cash:read',
  ...READ_CATALOG,
];

/** The counter's day: everything reception does without calling a manager. */
const SELL: Permission[] = [
  'pos:sale:create',
  'pos:sale:update',
  'pos:sale:discount',
  'pos:sale:void',
  'pos:payment:capture',
  'pos:payment:confirm',
  'pos:payment:void',
  'pos:refund:create',
  'pos:voucher:redeem',
  'pos:print:receipt',
  'pos:print:band',
  'pos:print:voucher',
  'pos:print:reprint',
];

/**
 * Seed role bundles (CLAUDE.md §4). platform_admin additionally bypasses
 * operator scoping (cross-tenant) — that flag lives on the role row, not here.
 *
 * The bundles nest: staff ⊆ reception ⊆ branch_manager ⊆ operator_admin. The
 * dominance rule (S2-01a) only lets an account grant a role whose every
 * permission it already holds, so a manager who could not grant `reception`
 * could not staff their own branch.
 */
export const ROLE_BUNDLES: Record<SystemRole, Permission[]> = {
  platform_admin: ALL,
  operator_admin: ALL,
  branch_manager: [
    ...READ_COUNTER,
    ...SELL,
    'admin:account:create',
    'admin:account:read',
    'admin:account:update',
    'admin:role:read',
    'admin:role:assign',
    'admin:audit:read',
    // Named here rather than inherited from READ_COUNTER: a branch manager
    // configures the estate, and the three station permissions travel together.
    'admin:station:read',
    'admin:station:create',
    'admin:station:update',
    'admin:box:command',
    'admin:box:read',
    'admin:device:create',
    'admin:device:read',
    'admin:device:update',
    'admin:device:pair',
    'admin:device:revoke',
    'admin:booth:read',
    'admin:booth:staff_assign',
    'admin:health:read',
    // The register is a manager's screen, not a counter's: it is in this
    // bundle and deliberately not in `reception` (SCRUM-246).
    'pos:member:list',
    'pos:member:create',
    'pos:member:update',
    'pos:member:tier_downgrade',
    'pos:child:create',
    'pos:child:update',
    'pos:visit:create',
    'pos:visit:update',
    // The arrivals list and the claim (SCRUM-306). Both counter roles hold
    // them; read-only `staff` hold neither, which is where `pos:visit:read`
    // used to put the waiting list.
    'pos:booking:read',
    'pos:booking:redeem',
    // Deliberately not in `reception`: a till taking a live station from a
    // colleague is the moment somebody senior should be standing there.
    'pos:station:takeover',
    'pos:payment:settle',
    'pos:refund:approve',
    'pos:cash:session_open',
    'pos:cash:session_close',
    'pos:cash:movement',
    'pos:cash:approve',
    'pos:cash:day_close',
    'pos:checkin:create',
    'pos:checkin:update',
    'pos:checkin:release',
    'pos:checkin:guardian_manage',
    'pos:wallet:grant',
    'pos:wallet:spend',
    'pos:wallet:adjust',
    'pos:wallet:reactivate',
    'pos:stock:adjust',
    'pos:stock:transfer',
    'pos:stock:count',
    'pos:stock:receive',
    'pos:stock:order',
    'pos:stock:approve',
    'catalog:package:create',
    'catalog:package:update',
    'catalog:holiday:manage',
    'catalog:tax:manage',
    'catalog:menu:manage',
    // Replacing the menu from a spreadsheet stops here: reception inherits the
    // read half through READ_COUNTER and neither of the write halves.
    'catalog:menu:import',
    // Staff benefits: a manager reads the screen; changing it is the operator
    // administrator's (plan "Permissions").
    'admin:benefit:read',
    'pos:benefit:apply',
    'analytics:read',
    'app:pos:access',
    'app:console:access',
    'app:booth:access',
    'booth:staff:sign_in',
  ],
  reception: [
    ...READ_COUNTER,
    ...SELL,
    'pos:member:create',
    'pos:member:update',
    'pos:child:create',
    'pos:child:update',
    'pos:visit:create',
    'pos:visit:update',
    'pos:booking:read',
    'pos:booking:redeem',
    'pos:cash:session_open',
    'pos:cash:session_close',
    'pos:cash:movement',
    // S2-15a (SCRUM-488, the owner's ruling): any signed-in staff member who
    // can open End of Day closes it, as in the prototype — reception included.
    'pos:cash:day_close',
    'pos:checkin:create',
    'pos:checkin:update',
    'pos:checkin:release',
    'pos:checkin:guardian_manage',
    'pos:wallet:grant',
    'pos:wallet:spend',
    'pos:stock:count',
    // S2-14b (OD-S4, R-76): all staff do the stock operations — moving stock
    // between shelves and taking a delivery; setup and orders stay a manager's.
    'pos:stock:transfer',
    'pos:stock:receive',
    'pos:benefit:apply',
    'app:pos:access',
    'app:booth:access',
    'booth:staff:sign_in',
  ],
  // `pos:cash:day_close` (S2-15a): `staff` opens the Today screen too, and the
  // prototype lets anybody who can open End of Day close it.
  // `pos:benefit:apply` (S2-21): the plan gives it to reception and staff alike.
  staff: [
    ...READ_COUNTER,
    'pos:cash:day_close',
    'pos:benefit:apply',
    'app:pos:access',
    'app:booth:access',
    'booth:staff:sign_in',
  ],
};
