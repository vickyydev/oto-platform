export default async function (S) {
  S.st.images = S.st.images.filter((i) => !/s765-st-05a-no-wallet-configure-one-kid|s765-st-05b-no-wallet-order-with-two-pairs/.test(i.file));
  S.st.abandonedPath = { at: '2026-11-04T20:28Z', what: 'A first step 5 attempt (1 Hour Play, one kid and no adult) opened the children-playing-alone screen; it was backed out before anything was rung up (no sale request sent) and its two pictures were deleted.' };
  S.st.redactJobs = [{ file: 's765-st-05b-no-wallet-payment-successful-socks-card', boxes: [[448, 622, 70, 70], [926, 710, 72, 72]] }]; S.save(); return 'ok';
}
