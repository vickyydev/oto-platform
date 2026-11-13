S.phase='cancel own unfinished family forms before payment proof';
const result={phone:await S.cancelSale(S.phone),desk:await S.cancelSale(S.till)};
await S.landing(S.till).waitFor();
await S.dropDisplay('main');
return result;
