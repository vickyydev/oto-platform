// Hide credit voucher QR codes (and the code under them) in a picture: whoever holds one can spend the credit.
import { readFileSync, writeFileSync } from 'node:fs';
export default async function (S) {
  const jobs = S.st.redactJobs ?? [];
  const ctx = await S.browser.newContext();
  const page = await ctx.newPage();
  const done = [];
  for (const { file, boxes } of jobs) {
    const path = S.OUT + '/' + file + '.png';
    const data = 'data:image/png;base64,' + readFileSync(path).toString('base64');
    const b64 = await page.evaluate(async ({ data, boxes }) => {
      const img = new Image(); img.src = data; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      for (const [x, y, w, h] of boxes) {
        g.fillStyle = '#3b3b3b'; g.fillRect(x, y, w, h);
        g.fillStyle = '#ffffff'; g.font = 'bold 14px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center';
        g.fillText('code hidden', x + w / 2, y + h / 2);
      }
      return c.toDataURL('image/png').split(',')[1];
    }, { data, boxes });
    writeFileSync(path, Buffer.from(b64, 'base64'));
    done.push({ file, n: boxes.length });
    (S.st.redacted = S.st.redacted ?? []).push({ file, boxes, at: new Date().toISOString() });
  }
  await ctx.close();
  S.st.redactJobs = []; S.save();
  return done;
}
