export default async function (S) {
  await S.shot('till', 's773-st-07c-member-looked-up-again-thai-verified-driving-licence');
  S.st.steps.s7.lookupAgain = { at: new Date().toISOString(), reads: 'Thai · verified; Thai card: Driving licence — no proof needed' }; S.save();
  return 'ok';
}
