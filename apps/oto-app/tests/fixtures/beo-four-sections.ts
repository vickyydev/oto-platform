/**
 * SCRUM-1029: one ZZ TEST party with every field the BEO editor shows filled in,
 * as the BEO's read answers it (`GET /api/events/:eventId/beo`), and its
 * package snapshot. The four-sections check opens it in the editor and saves it.
 * No real name, number or party: every word is the test's own.
 */
export const FOUR_SECTIONS_PARK = "33333333-3333-4333-8333-333333333333";
export const FOUR_SECTIONS_EVENT = "11111111-1111-4111-8111-000000001029";
export const FOUR_SECTIONS_HOST = "55555555-5555-4555-8555-000000000001";
export const FOUR_SECTIONS_BACKUP = "55555555-5555-4555-8555-000000000002";
export const FOUR_SECTIONS_DEPT = "66666666-6666-4666-8666-000000000001";

export function fourSectionsBeo(id: string = FOUR_SECTIONS_EVENT, over: Record<string, unknown> = {}) {
  return {
    id,
    title: "ZZ TEST 1029 party",
    eventDate: "2099-05-16",
    startTime: "11:00",
    endTime: "14:00",
    durationMinutes: 180,
    numChildren: 11,
    numAdults: 10,
    locationId: null,
    locationText: "ZZ TEST Party Room A",
    activities: "ZZ TEST games",
    decoration: "ZZ TEST balloons",
    specialRequests: "ZZ TEST a quiet corner",
    internalStaffNotes: "ZZ TEST final message",
    childName: "ZZ TEST Child",
    bookingName: "ZZ TEST Booking",
    parentName: "ZZ TEST Parent",
    whatsappPhoneRaw: "ZZ TEST contact",
    kidTurningAge: 6,
    eventType: "birthday",
    color: null,
    branchId: FOUR_SECTIONS_PARK,
    inboxConversationId: null,
    isArchived: false,
    partyHost: {
      id: "77777777-7777-4777-8777-000000000001",
      eventId: id,
      assignmentMode: "INDIVIDUAL",
      assignedEmployeeId: FOUR_SECTIONS_HOST,
      backupEmployeeId: FOUR_SECTIONS_BACKUP,
    },
    setupPlan: {
      setupRequired: true,
      setupNotes: "ZZ TEST setup notes",
      setupTasks: {
        readyBy: "10:00",
        responsible: "ZZ TEST Floor (Dept)",
        responsibleId: FOUR_SECTIONS_DEPT,
        responsibleType: "department",
        simplifiedTasks: [
          { id: "task_zz_1", itemLabel: "ZZ TEST table cloth", notes: "ZZ TEST blue" },
          { id: "task_zz_2", itemLabel: "ZZ TEST balloon arch", notes: "" },
        ],
      },
    },
    kitchenPlan: {
      foodRequired: true,
      cakeMode: "INTERNAL",
      cakeQuantity: 2,
      cakeNotes: "ZZ TEST mix flavour",
      cakeTime: "13:30",
      setMenuEnabled: false,
      setMenuTemplateId: null,
      setMenuSelectionStatus: null,
      menus: {
        kids: [
          { id: "menu_zz_k1", itemName: "ZZ TEST Margherita", quantity: 3, notes: "", included: true, price: 0, source: "set_menu", groupId: "group_zz_1" },
          { id: "menu_zz_k2", itemName: "ZZ TEST Fries", quantity: 2, notes: "ZZ TEST crispy", included: false, price: 80, source: "additional", chargeApproved: true, billingSync: "none", productCode: "ZZ-FRY" },
        ],
        adults: [
          { id: "menu_zz_a1", itemName: "ZZ TEST Salmon", quantity: 2, notes: "", included: false, price: 0, source: "additional" },
        ],
        adultsDiffer: true,
        kidsFoodTime: "11:30",
        adultsFoodTime: "12:00",
        cakePrice: 0,
        cakeIncluded: true,
      },
    },
    barPlan: {
      serviceTime: "11:30",
      items: [
        { id: "bar_zz_1", itemName: "ZZ TEST Mors", quantity: 2, notes: "", price: 0, source: "set_menu" },
        { id: "bar_zz_2", itemName: "ZZ TEST Lemonade", quantity: 3, notes: "ZZ TEST no ice", price: 60, productCode: "ZZ-LEM", chargeApproved: true, billingSync: "none" },
      ],
    },
    partyDetails: {
      packageName: "ZZ TEST POS name",
      packageBasePrice: 0,
      items: [
        { id: "pi_zz_1", description: "ZZ TEST photo zone", type: "included", price: 0, notes: "" },
        { id: "pi_zz_2", description: "ZZ TEST bubble show", type: "extra", price: 0, notes: "ZZ TEST at 12:30" },
      ],
      prepaymentReceived: 3000,
      depositDate: "2099-05-01",
      notes: "ZZ TEST POS note",
    },
    prepaymentAmount: 3000,
    prepaymentDate: "2099-05-01",
    oneDeposit: { amountThb: 3000, date: "2099-05-01" },
    beoTasks: [],
    timeline: [
      { id: "88888888-8888-4888-8888-000000000001", eventId: id, label: "ZZ TEST pinata", offsetFromStartMinutes: 150, isSystemGenerated: false, sourceKey: null, sortOrder: 1, isCompleted: false, assignedToType: "PARTY_HOST" },
    ],
    ...over,
  };
}

/** The party's package as its snapshot stores it (beo_package_snapshots and its items). */
export function fourSectionsSnapshot(id: string = FOUR_SECTIONS_EVENT) {
  return {
    id: "99999999-9999-4999-8999-000000000001",
    eventId: id,
    templateId: null,
    templateUpdatedAtAtApply: null,
    packageName: "ZZ TEST Weekend Birthday",
    basePrice: 0,
    includedSummary: "ZZ TEST play, basic program, cake",
    excludedSummary: null,
    kidsIncluded: 10,
    adultsIncluded: 4,
    socksIncluded: -1,
    hours: 3,
    priceWeekday: 1_690_000,
    priceWeekend: 2_090_000,
    extraChildWeekday: null,
    extraChildWeekend: null,
    extraAdultWeekday: null,
    extraAdultWeekend: null,
    slipsTime: "10:45:00",
    items: [
      { id: "si_zz_1", snapshotId: "s", category: "Food", label: "ZZ TEST ice-cream cake", description: null, qty: 1, unitLabel: null, included: true, unitPrice: 0, billable: false, notes: null, sortOrder: 0 },
      { id: "si_zz_2", snapshotId: "s", category: "Table", label: "ZZ TEST reserved adults' table", description: null, qty: 1, unitLabel: null, included: false, unitPrice: 500_000, billable: true, notes: null, sortOrder: 1 },
      { id: "si_zz_3", snapshotId: "s", category: "Decor", label: "ZZ TEST balloon decoration", description: null, qty: 0, unitLabel: null, included: false, unitPrice: 400_000, billable: true, notes: null, sortOrder: 2 },
    ],
  };
}
