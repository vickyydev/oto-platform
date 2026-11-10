/**
 * SCRUM-822 — the platform's answers for a party's money (`GET
 * /otoapp/parties/:eventId/billing`), as the api's own integration test
 * (apps/api/test/otoapp-party-billing.test.ts) reads them for the staging
 * proof's party: the Floresta package on a Wednesday, ten children and four
 * adults, a ฿3,000 deposit, and a ฿125 item the BEO added. Satang throughout,
 * every field the platform sends (its PartyBillingAnswerSchema).
 */

const park = { name: "OTO", branchName: "Oto Play Park, Central Floresta", address: "Central Floresta, Phuket" };
const party = {
  title: "ZZ TEST Floresta party 822",
  date: "2026-11-18",
  startTime: "13:00",
  endTime: "16:00",
  packageName: "ZZ TEST Floresta Birthday",
  kids: 10,
  adults: 4,
};

const lines = [
  { role: "package", label: "ZZ TEST Floresta Birthday", quantity: 1, unitSatang: 1_690_000, totalSatang: 1_690_000 },
  { role: "included", label: "Kids' table reserved for 3 hours", quantity: 1, unitSatang: 0, totalSatang: 0 },
  { role: "included", label: "Ice-cream cake with candles", quantity: 1, unitSatang: 0, totalSatang: 0 },
  { role: "guests", label: "Children (in the package)", quantity: 10, unitSatang: 0, totalSatang: 0 },
  { role: "guests", label: "Adults (in the package)", quantity: 4, unitSatang: 0, totalSatang: 0 },
  { role: "socks", label: "Regular Socks (free)", quantity: 10, unitSatang: 0, totalSatang: 0 },
  { role: "add_on", label: "ZZ TEST bubble tea", quantity: 1, unitSatang: 12_500, totalSatang: 12_500 },
];

/** Before settlement: ฿16,900 + ฿125 = ฿17,025; ฿3,000 paid; ฿14,025 to take. */
export function quoteAnswer(eventId: string) {
  return {
    eventId,
    state: "quote",
    park: { ...park },
    party: { ...party },
    quote: {
      partyDate: "2026-11-18",
      rateMode: "weekday",
      packageName: "ZZ TEST Floresta Birthday",
      lines: lines.map((l) => ({ ...l })),
      packageSatang: 1_690_000,
      extraChildren: 0,
      extraChildrenSatang: 0,
      extraAdults: 0,
      extraAdultsSatang: 0,
      freeSocks: 10,
      paidSocks: 0,
      socksSatang: 0,
      addOnsSatang: 12_500,
      entertainmentSatang: 0,
      totalSatang: 1_702_500,
      creditSatang: 0,
      depositSatang: 300_000,
      balanceSatang: 1_402_500,
      walkUps: 0,
      walkUpsSatang: 0,
    },
    sale: null,
    noQuote: null,
  };
}

/** After a cash settlement at the till: the receipt, the deposit and the cash. */
export function saleAnswer(eventId: string) {
  return {
    eventId,
    state: "sale",
    park: { ...park },
    party: { ...party },
    quote: null,
    sale: {
      saleId: "0197a000-0000-7000-8000-000000000822",
      settlementId: "0197a000-0000-7000-8000-000000000823",
      state: "settled",
      receiptNumber: "T1-000822",
      lines: lines.map((l) => ({ ...l })),
      payments: [
        { id: "0197a000-0000-7000-8000-000000000824", label: "Deposit paid in advance", methodCode: "deposit_paid_in_advance", amountSatang: 300_000, deposit: true, paidAt: "2026-11-18T06:00:00.000Z" },
        { id: "0197a000-0000-7000-8000-000000000825", label: "Cash", methodCode: "cash", amountSatang: 1_402_500, deposit: false, paidAt: "2026-11-18T09:05:00.000Z" },
      ],
      grossSatang: 1_702_500,
      paidSatang: 1_702_500,
      depositSatang: 300_000,
      outstandingSatang: 0,
      kids: 10,
      adults: 4,
      createdAt: "2026-11-18T06:00:00.000Z",
      settledAt: "2026-11-18T09:05:00.000Z",
      stationName: "ZZ TEST Till 1",
    },
    noQuote: null,
  };
}

/** A party the till cannot price: no package in the OTO App. */
export function noQuoteAnswer(eventId: string) {
  return {
    eventId,
    state: "no_quote",
    park: { ...park },
    party: { ...party, packageName: null },
    quote: null,
    sale: null,
    noQuote: { code: "PARTY_NO_PACKAGE", message: "This party has no package in the OTO App, so it cannot be settled here" },
  };
}
