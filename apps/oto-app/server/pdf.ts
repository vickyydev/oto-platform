import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import DOMPurify from "isomorphic-dompurify";
import { Readable } from "stream";
import { getFileFromObjectStorage } from "./file-storage";
import { formatParkSignedDate, getLocalDateString } from "./timezone-utils";
import { tillFiguresOf, type TillBillingReading } from "@shared/tillBilling";
import { ADULTS_ONLY_MARK, ADULTS_SAME_AS_KIDS, adultsDifferOf, kitchenAdultsMarks } from "@shared/kitchenAdults";
import { beoExtraChargeOf, beoExtraPrintWordsOf, beoPrintFoldable, type BeoExtraContext } from "@shared/beoExtras";
import { beoPdfTillMoneyHtml } from "./lib/beoPdfMoney";

// Resolve a stored branch logo before Chromium renders. Remote object storage
// is the normal deployment path; the local file is kept for older dev uploads.
async function getLogoAsDataUrl(logoUrl: string | undefined): Promise<string | undefined> {
  if (!logoUrl) return undefined;
  if (logoUrl.startsWith('data:')) return logoUrl;

  const match = /^\/(?:api\/files|uploads)\/branch-logos\/([^/?#]+)$/.exec(logoUrl);
  if (!match) return undefined;
  try {
    const filename = decodeURIComponent(match[1]);
    if (path.basename(filename) !== filename) return undefined;
    const stored = await getFileFromObjectStorage('branch-logos', filename);
    if (stored) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stored.stream as Readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 2 * 1024 * 1024) return undefined;
        chunks.push(bytes);
      }
      return `data:${stored.contentType};base64,${Buffer.concat(chunks).toString('base64')}`;
    }
    const filePath = path.join(process.cwd(), 'uploads', 'branch-logos', filename);
    if (!fs.existsSync(filePath)) return undefined;
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > 2 * 1024 * 1024) return undefined;
    const base64 = buffer.toString('base64');
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.svg') mimeType = 'image/svg+xml';
    else if (ext === '.webp') mimeType = 'image/webp';
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error('Failed to load branch logo for PDF', error);
    return undefined;
  }
}

function createBlankSignatureBlockHtml(): string {
  return `
    <div class="signatures-section" style="margin-top: 60px; page-break-inside: avoid;">
      <h2 style="color: #2d3748; margin-bottom: 30px;">Signatures</h2>
      <div style="display: flex; justify-content: space-between; gap: 40px;">
        <div class="employee-signature" style="flex: 1;">
          <div style="min-height: 80px; border-bottom: 2px solid #000; margin-bottom: 8px;"></div>
          <p style="margin: 4px 0; font-weight: bold;">Employee Signature</p>
          <p style="margin: 4px 0;">Name: ____________</p>
          <p style="margin: 4px 0;">Date: ____________</p>
        </div>
        <div class="employer-signature" style="flex: 1;">
          <div style="min-height: 80px; border-bottom: 2px solid #000; margin-bottom: 8px;"></div>
          <p style="margin: 4px 0; font-weight: bold;">Employer Signature</p>
          <p style="margin: 4px 0;">Name: ____________</p>
          <p style="margin: 4px 0;">Title: ____________</p>
          <p style="margin: 4px 0;">Date: ____________</p>
        </div>
      </div>
    </div>
  `;
}

export async function wrapContentInDocument(
  content: string, 
  branchHeader?: { name: string; address: string; logoUrl?: string },
  options?: { appendSignatureSection?: boolean }
): Promise<string> {
  if (content.trim().toLowerCase().startsWith('<!doctype')) {
    return DOMPurify.sanitize(content, { WHOLE_DOCUMENT: true });
  }
  
  const sanitizedContent = DOMPurify.sanitize(content);

  // Build header HTML based on what's available
  let headerHtml = '';
  if (branchHeader && (branchHeader.logoUrl || branchHeader.name || branchHeader.address)) {
    // Convert logo URL to data URL for PDF embedding
    const logoDataUrl = await getLogoAsDataUrl(branchHeader.logoUrl);
    const hasLogo = !!logoDataUrl;
    const hasInfo = !!(branchHeader.name || branchHeader.address);
    
    headerHtml = `<div class="branch-header" style="justify-content: ${hasLogo && hasInfo ? 'space-between' : hasLogo ? 'flex-start' : 'flex-end'};">`;
    
    if (hasLogo) {
      headerHtml += `
        <div class="branch-logo">
          <img src="${logoDataUrl}" alt="Company Logo" />
        </div>`;
    }
    
    if (hasInfo) {
      headerHtml += `
        <div class="branch-info">
          ${branchHeader.name ? `<div class="branch-name">${branchHeader.name}</div>` : ''}
          ${branchHeader.address ? `<div class="branch-address">${branchHeader.address}</div>` : ''}
        </div>`;
    }
    
    headerHtml += `</div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page {
      size: A4;
      margin: 20mm;
    }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a202c;
      max-width: 210mm;
      margin: 0 auto;
      padding: 0;
      background: white;
    }
    .branch-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #1a365d;
    }
    .branch-logo {
      flex: 0 0 auto;
    }
    .branch-logo img {
      max-height: 60px;
      max-width: 150px;
    }
    .logo-placeholder {
      width: 80px;
      height: 60px;
      background: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      color: #64748b;
      font-size: 10px;
    }
    .branch-info {
      text-align: right;
      flex: 1;
      padding-left: 20px;
    }
    .branch-name {
      font-weight: 700;
      font-size: 16px;
      color: #1a365d;
    }
    .branch-address {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #1a365d;
      margin-bottom: 16px;
      margin-top: 24px;
      page-break-after: avoid;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 12px;
      margin-top: 20px;
      page-break-after: avoid;
    }
    h3 {
      font-size: 16px;
      font-weight: 600;
      color: #4a5568;
      margin-bottom: 8px;
      margin-top: 16px;
      page-break-after: avoid;
    }
    p {
      margin-bottom: 12px;
      page-break-inside: avoid;
    }
    ul, ol {
      margin-left: 24px;
      margin-bottom: 12px;
    }
    li {
      margin-bottom: 6px;
    }
    strong {
      font-weight: 600;
    }
    a {
      color: #3182ce;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  ${headerHtml}
  ${sanitizedContent}
  ${options?.appendSignatureSection ? createBlankSignatureBlockHtml() : ''}
</body>
</html>`;
}

export async function generatePdf(html: string, branchHeader?: { name: string; address: string; logoUrl?: string }): Promise<Buffer> {
  // Include blank signature section for unsigned contracts
  const wrappedHtml = await wrapContentInDocument(html, branchHeader, { appendSignatureSection: true });
  
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(wrappedHtml, { waitUntil: "networkidle0" });

    const pdfBytes = await page.pdf({
      format: "A4",
      margin: {
        top: "20mm",
        right: "20mm",
        bottom: "20mm",
        left: "20mm",
      },
      printBackground: true,
    });

    return Buffer.from(pdfBytes);
  } finally {
    await browser.close();
  }
}

interface SignatureData {
  employeeSignatureImage?: string;
  employeeSignedName?: string;
  employeeSignedDate?: string;
  employerSignatureImage?: string;
  employerSignedName?: string;
  employerSignedTitle?: string;
  employerSignedDate?: string;
}

export function createSignatureBlockHtml(signatureData: SignatureData): string {
  return `
    <div class="signatures-section" style="margin-top: 60px; page-break-inside: avoid;">
      <h2 style="color: #2d3748; margin-bottom: 30px;">Signatures</h2>
      <div style="display: flex; justify-content: space-between; gap: 40px;">
        <div class="employee-signature" style="flex: 1;">
          <div style="min-height: 80px; border-bottom: 2px solid #000; margin-bottom: 8px; display: flex; align-items: flex-end; padding-bottom: 5px;">
            ${signatureData.employeeSignatureImage 
              ? `<img src="${signatureData.employeeSignatureImage}" alt="Employee Signature" style="max-height: 70px; max-width: 200px;" />`
              : ''
            }
          </div>
          <p style="margin: 4px 0; font-weight: bold;">Employee Signature</p>
          ${signatureData.employeeSignedName 
            ? `<p style="margin: 4px 0;">Name: ${signatureData.employeeSignedName}</p>` 
            : '<p style="margin: 4px 0;">Name: ____________</p>'
          }
          ${signatureData.employeeSignedDate 
            ? `<p style="margin: 4px 0;">Date: ${signatureData.employeeSignedDate}</p>` 
            : '<p style="margin: 4px 0;">Date: ____________</p>'
          }
        </div>
        <div class="employer-signature" style="flex: 1;">
          <div style="min-height: 80px; border-bottom: 2px solid #000; margin-bottom: 8px; display: flex; align-items: flex-end; padding-bottom: 5px;">
            ${signatureData.employerSignatureImage 
              ? `<img src="${signatureData.employerSignatureImage}" alt="Employer Signature" style="max-height: 70px; max-width: 200px;" />`
              : ''
            }
          </div>
          <p style="margin: 4px 0; font-weight: bold;">Employer Signature</p>
          ${signatureData.employerSignedName 
            ? `<p style="margin: 4px 0;">Name: ${signatureData.employerSignedName}</p>` 
            : '<p style="margin: 4px 0;">Name: ____________</p>'
          }
          ${signatureData.employerSignedTitle 
            ? `<p style="margin: 4px 0;">Title: ${signatureData.employerSignedTitle}</p>` 
            : ''
          }
          ${signatureData.employerSignedDate 
            ? `<p style="margin: 4px 0;">Date: ${signatureData.employerSignedDate}</p>` 
            : '<p style="margin: 4px 0;">Date: ____________</p>'
          }
        </div>
      </div>
    </div>
  `;
}

function removeExistingSignatureSection(html: string): string {
  // Remove old-style signature sections from template
  let result = html;
  
  // Remove signature section with class="section" containing Signatures heading (any nesting level)
  result = result.replace(/<div class="section">\s*<h2>\s*Signatures?\s*<\/h2>[\s\S]*?(?:<\/div>\s*){2,3}/gi, '');
  
  // Remove section.signature-block
  result = result.replace(/<section[^>]*class="[^"]*signature-block[^"]*"[^>]*>[\s\S]*?<\/section>/gi, '');
  
  // Remove any div with signature-section class
  result = result.replace(/<div[^>]*class="[^"]*signature-section[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  
  // Remove standalone signature-line divs
  result = result.replace(/<div class="signature-line"[^>]*>[\s\S]*?<\/div>/gi, '');
  
  // Remove the Digital Signature box pattern from old PDFs
  result = result.replace(/<div[^>]*style="[^"]*margin-top:\s*40px[^"]*padding:\s*20px[^"]*border:\s*2px solid[^"]*"[^>]*>[\s\S]*?<h3[^>]*>Digital Signature<\/h3>[\s\S]*?<\/div>/gi, '');
  
  // Remove old signatures section heading without content
  result = result.replace(/<h2>\s*Signatures?\s*<\/h2>\s*/gi, '');
  
  return result;
}

export async function generateSignedPdf(
  html: string,
  contractId: string,
  signatureName: string,
  signedAt: Date,
  branchHeader?: { name: string; address: string; logoUrl?: string },
  signatureImage?: string,
  employerSignatureData?: { name: string; title: string; image: string; date: string }
): Promise<Buffer> {
  const signedDateStr = formatParkSignedDate(signedAt);
  
  // Build signature data
  const signatureData: SignatureData = {
    employeeSignatureImage: signatureImage,
    employeeSignedName: signatureName,
    employeeSignedDate: signedDateStr,
    employerSignatureImage: employerSignatureData?.image,
    employerSignedName: employerSignatureData?.name,
    employerSignedTitle: employerSignatureData?.title,
    employerSignedDate: employerSignatureData?.date || signedDateStr,
  };
  
  // Remove existing signature section from template
  let cleanHtml = removeExistingSignatureSection(html);
  
  // Create the signature block HTML
  const signatureBlockHtml = createSignatureBlockHtml(signatureData);
  
  // Insert signature block before </body> or at the end
  const contentWithSignature = cleanHtml.includes("</body>") 
    ? cleanHtml.replace("</body>", `${signatureBlockHtml}</body>`)
    : cleanHtml + signatureBlockHtml;

  // Don't append signature section - we already have a filled-in one
  const wrappedHtml = await wrapContentInDocument(contentWithSignature, branchHeader, { appendSignatureSection: false });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(wrappedHtml, { waitUntil: "networkidle0" });

    const pdfUint8Array = await page.pdf({
      format: "A4",
      margin: {
        top: "20mm",
        right: "20mm",
        bottom: "20mm",
        left: "20mm",
      },
      printBackground: true,
    });

    return Buffer.from(pdfUint8Array);
  } finally {
    await browser.close();
  }
}

// Generate signed letter PDF (resignation, termination, warning letters)
export async function generateSignedLetterPdf(
  html: string,
  letterId: string,
  letterType: string,
  signatureName: string,
  signedAt: Date,
  signatureImage: string,
  branchHeader?: { name: string; address: string; logoUrl?: string }
): Promise<Buffer> {
  const signedDateStr = formatParkSignedDate(signedAt);
  
  // Create employee-only signature block (letters typically only need employee signature)
  const signatureBlockHtml = `
    <div class="signatures-section" style="margin-top: 60px; page-break-inside: avoid;">
      <h2 style="color: #2d3748; margin-bottom: 30px;">Acknowledgment</h2>
      <div style="max-width: 400px;">
        <div class="employee-signature">
          ${signatureImage ? `<img src="${signatureImage}" alt="Signature" style="max-height: 80px; max-width: 200px; margin-bottom: 8px;" />` : ''}
          <div style="border-bottom: 2px solid #000; margin-bottom: 8px;"></div>
          <p style="margin: 4px 0; font-weight: bold;">Employee Signature</p>
          <p style="margin: 4px 0;">Name: ${signatureName}</p>
          <p style="margin: 4px 0;">Date: ${signedDateStr}</p>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing signature placeholders
  let cleanHtml = removeExistingSignatureSection(html);
  
  // Insert signature block
  const contentWithSignature = cleanHtml.includes("</body>") 
    ? cleanHtml.replace("</body>", `${signatureBlockHtml}</body>`)
    : cleanHtml + signatureBlockHtml;

  const wrappedHtml = await wrapContentInDocument(contentWithSignature, branchHeader, { appendSignatureSection: false });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(wrappedHtml, { waitUntil: "networkidle0" });

    const pdfUint8Array = await page.pdf({
      format: "A4",
      margin: {
        top: "20mm",
        right: "20mm",
        bottom: "20mm",
        left: "20mm",
      },
      printBackground: true,
    });

    return Buffer.from(pdfUint8Array);
  } finally {
    await browser.close();
  }
}

export interface BeoPdfData {
  eventTitle: string;
  eventDate: string;
  startTime: string;
  endTime?: string;
  status: string;
  childName?: string;
  parentName?: string;
  bookingName?: string;
  whatsappPhone?: string;
  kidTurningAge?: number;
  numChildren?: number;
  numAdults?: number;
  programName?: string;
  programDetails?: string;
  activities?: string;
  decoration?: string;
  location?: string;
  locationText?: string;
  allergiesNotes?: string;
  cakeNotes?: string;
  specialRequests?: string;
  internalStaffNotes?: string;
  partyHost?: {
    assignedName?: string;
    backupName?: string;
    roleName?: string;
    responsibilities?: string[];
    notes?: string;
  };
  setupPlan?: {
    readyBy?: string;
    responsible?: string;
    tasks?: { itemLabel: string; notes?: string }[];
    notes?: string;
  };
  kitchenPlan?: {
    required?: boolean;
    menus?: {
      kids?: { quantity: number; itemName: string; notes?: string; price?: number; included?: boolean; source?: string; productCode?: string }[];
      adults?: { quantity: number; itemName: string; notes?: string; price?: number; included?: boolean; source?: string; productCode?: string }[];
      /** SCRUM-829: "Different for adults"; absent on a BEO saved before the switch (shared/kitchenAdults.ts). */
      adultsDiffer?: boolean;
      kidsFoodTime?: string;
      adultsFoodTime?: string;
    };
    simplifiedMenus?: {
      kids?: { itemName: string; notes?: string; price?: number; included?: boolean; source?: string }[];
      adults?: { itemName: string; notes?: string; price?: number; included?: boolean; source?: string }[];
    };
    setMenuEnabled?: boolean;
    setMenuTemplateName?: string;
    setMenuSelectionStatus?: { isSubmitted: boolean; submittedAt: string | null } | null;
    cakeMode?: string;
    cakeQuantity?: number;
    cakeTime?: string;
    cakeNotes?: string;
    cakePrice?: number;
    cakeIncluded?: boolean;
    notes?: string;
  };
  barPlan?: {
    serviceTime?: string;
    // SCRUM-949: an EXTRA drink's price for each item, as the kitchen's lines carry theirs.
    items?: { quantity: number; itemName: string; notes?: string; source?: string; price?: number; productCode?: string }[];
  };
  /**
   * SCRUM-970: the till's menu as read for the party's park (the BEO editor's own reading), for
   * what the till charges an EXTRA line with no price entered; absent or not read: such a coded
   * line prints its badge alone, as before.
   */
  extrasTill?: BeoExtraContext["till"];
  /** SCRUM-970: the park's time zone, for every date the PDF prints; the park group's default when absent. */
  parkTimeZone?: string;
  partyDetails?: {
    packageName?: string;
    packageBasePrice?: number;
    items?: { id?: string; label: string; type: string; price: number; notes?: string }[];
    prepaymentReceived?: number;
    depositDate?: string;
    notes?: string;
  };
  /** SCRUM-822: the party's money as the till answered it when the PDF was made, or why it did not. */
  till?: TillBillingReading;
  timeline?: {
    time: string;
    description: string;
  }[];
  branchName?: string;
  branchAddress?: string;
  branchLogoUrl?: string;
}

/** SCRUM-970: the park's time zone when it names one the clock knows; else the park group's default (Bangkok). */
function parkZoneOf(timeZone: string | null | undefined): string {
  const zone = timeZone?.trim();
  if (!zone) return "Asia/Bangkok";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "Asia/Bangkok";
  }
}

/** SCRUM-970: a moment's day and month on the park's clock ("13 Nov"); empty when it is no moment. */
export function parkDayMonthOf(at: string | Date, timeZone: string | null | undefined): string {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: parkZoneOf(timeZone) });
}

/** SCRUM-970: a moment's date on the park's clock, dd/mm/yyyy (`formatParkSignedDate`'s form, at the party's park). */
export function parkDateOf(at: Date, timeZone: string | null | undefined): string {
  const [year, month, day] = getLocalDateString(at, parkZoneOf(timeZone)).split("-");
  return `${day}/${month}/${year}`;
}

/** The BEO PDF as HTML, before Chromium prints it: what the page says, for a check to read. */
export async function beoPdfHtml(data: BeoPdfData): Promise<string> {
  const formatCurrency = (amount: number) => `${amount.toLocaleString()}฿`;
  const s = (str: string) => DOMPurify.sanitize(str);
  // SCRUM-970: every date the PDF prints is the park's (the server's clock is UTC: "Received 12 Nov"
  // for a choice made on the 13th between midnight and 07:00 at the park).
  const parkZone = parkZoneOf(data.parkTimeZone);
  // SCRUM-970: an EXTRA line prints what the editor's hint says for it (shared/beoExtras.ts): the price
  // entered for each item, the till's price for the party's day, or "not charged"; the badge alone for
  // a coded line the till's menu could not price.
  const extrasCtx: BeoExtraContext = { till: data.extrasTill ?? { known: false, byCode: new Map() }, partyDate: data.eventDate || null };
  const extraBadge = (item: { quantity?: number; itemName?: string; price?: number; source?: string; productCode?: string }, area: "food" | "bar") => {
    const words = beoExtraPrintWordsOf(
      beoExtraChargeOf(
        { itemName: item.itemName ?? "", quantity: item.quantity ?? 1, price: item.price ?? null, source: item.source ?? null, productCode: item.productCode ?? null },
        area,
        extrasCtx,
      ),
    );
    return `<span class="extra-badge">EXTRA</span>${words ? ` <span class="price">${s(words)}</span>` : ''}`;
  };

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function formatEventDate(dateStr: string): string {
    const parts = dateStr.split("-");
    if (parts.length !== 3) return dateStr;
    const day = parseInt(parts[2], 10);
    const month = MONTHS[parseInt(parts[1], 10) - 1] || parts[1];
    const yearShort = "'" + parts[0].slice(2);
    return `${day} ${month} ${yearShort}`;
  }
  const formattedDate = formatEventDate(data.eventDate);
  const formattedTime = data.startTime + (data.endTime ? ` – ${data.endTime}` : '');
  const locationDisplay = data.locationText || data.location || '';

  // SCRUM-978: a section with nothing to print prints no heading. The editor's Save keeps a party
  // host and a setup plan row with nothing in them, and the PDF then printed "PARTY HOST" and
  // "SETUP PLAN" with nothing under them (before any Save, neither was printed).
  const partyHostHasText = !!data.partyHost && !!(
    data.partyHost.assignedName || data.partyHost.backupName || data.partyHost.roleName || data.partyHost.notes
  );
  const setupPlanHasText = !!data.setupPlan && !!(
    data.setupPlan.readyBy || data.setupPlan.responsible || data.setupPlan.tasks?.length || data.setupPlan.notes
  );
  const partyHostHtml = partyHostHasText && data.partyHost ? `
    <div class="section">
      <h2>Party Host</h2>
      <div class="info-grid">
        ${data.partyHost.assignedName ? `<div class="info-item"><span class="info-label">Assigned:</span><span class="info-value">${s(data.partyHost.assignedName)}</span></div>` : ''}
        ${data.partyHost.backupName ? `<div class="info-item"><span class="info-label">Backup:</span><span class="info-value">${s(data.partyHost.backupName)}</span></div>` : ''}
        ${data.partyHost.roleName && !data.partyHost.assignedName ? `<div class="info-item"><span class="info-label">Role:</span><span class="info-value">${s(data.partyHost.roleName)}</span></div>` : ''}
      </div>
      ${data.partyHost.notes ? `<p class="notes">${s(data.partyHost.notes)}</p>` : ''}
    </div>
  ` : '';

  // SCRUM-822: the POS section's money is the till's (server/lib/beoPdfMoney.ts), as on the BEO's
  // screens; Party Details' lines are printed as written, with no price and no sum of the app's own.
  const packageHtml = (() => {
    const pd = data.partyDetails;
    const till = tillFiguresOf(data.till);
    if (!pd && !till) return '';
    const includedItems = pd?.items?.filter(i => i.type === "included") || [];
    const extraItems = pd?.items?.filter(i => i.type === "extra") || [];
    const packageName = pd?.packageName || till?.packageName;

    return `
      <div class="section">
        <h2>POS${packageName ? `: ${s(packageName)}` : ''}</h2>
        ${includedItems.length ? `
          <h3>Included</h3>
          <table class="menu-table">
            ${includedItems.map(item => `<tr>
              <td>${s(item.label || item.description)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
              <td class="price-col"><span class="incl-badge">INCL</span></td>
            </tr>`).join('')}
          </table>
        ` : ''}
        ${extraItems.length ? `
          <h3>Extras</h3>
          <table class="menu-table">
            ${extraItems.map(item => `<tr>
              <td>${s(item.label || item.description)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
              <td class="price-col"><span class="extra-badge">EXTRA</span></td>
            </tr>`).join('')}
          </table>
        ` : ''}
        ${beoPdfTillMoneyHtml(data.till, pd?.depositDate)}
        ${pd?.notes ? `<p class="notes">${s(pd.notes)}</p>` : ''}
      </div>
    `;
  })();

  const setupHtml = setupPlanHasText && data.setupPlan ? `
    <div class="section">
      <h2>Setup Plan</h2>
      <div class="info-grid" style="margin-bottom: 6px;">
        ${data.setupPlan.readyBy ? `<div class="info-item"><span class="info-label">Ready By:</span><span class="info-value">${s(data.setupPlan.readyBy)}</span></div>` : ''}
        ${data.setupPlan.responsible ? `<div class="info-item"><span class="info-label">Who:</span><span class="info-value">${s(data.setupPlan.responsible)}</span></div>` : ''}
      </div>
      ${data.setupPlan.tasks?.length ? `
        <table class="timeline-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${data.setupPlan.tasks.map(task => `
              <tr>
                <td>${s(task.itemLabel)}</td>
                <td>${task.notes ? s(task.notes) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}
      ${data.setupPlan.notes ? `<p class="notes">${s(data.setupPlan.notes)}</p>` : ''}
    </div>
  ` : '';

  // SCRUM-958 (SCRUM-940 point 3): a line's note in brackets, once: a set-menu choice's note is
  // already its group in brackets ("(Pizza)", the parent link's and the approval's mark), so it
  // printed "Margherita ((Pizza))".
  const noteInBrackets = (note: string) => {
    const t = note.trim();
    return t.startsWith('(') && t.includes(')') ? t : `(${t})`;
  };

  // SCRUM-829: the adults' change beside a line of the one food list, in the kitchen's words.
  const adultsMarkHtml = (mark: string | null | undefined) =>
    mark ? ` <span class="item-note" style="color:#92400e;font-weight:600;">— ${s(mark)}</span>` : '';

  // SCRUM-906: a price entered on an EXTRA line is the price of one (the owner, 12 November):
  // the till charges it times the line's count, so the BEO prints it "120฿ each".
  const menuItemRow = (item: { quantity: number; itemName: string; notes?: string; price?: number; included?: boolean; source?: string; productCode?: string }, mark: string | null = null) => {
    const isSet = item.source === 'set_menu';
    const badge = isSet
      ? '<span class="incl-badge" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd;">SET</span>'
      : extraBadge(item, 'food');
    return `<tr>
      <td class="qty">${item.quantity}x</td>
      <td>${s(item.itemName)}${item.notes ? ` <span class="item-note">${s(noteInBrackets(item.notes))}</span>` : ''}${adultsMarkHtml(mark)}</td>
      <td class="price-col">${badge}</td>
    </tr>`;
  };

  const kp = data.kitchenPlan;

  // SCRUM-829: ONE food list. The kids' menu is the main selection; the adults eat it unless
  // "Different for adults" is on, and then their changes are marked beside the kids' lines
  // ("kids only", "kids N · adults M", "adults: <note>") and their own dishes listed after,
  // marked "adults only" — never a second list.
  // SCRUM-978: the kids' list the editor and the till read: `menus` (canonical, kitchenPlanDbDataOf in
  // beo-routes.ts), `simplifiedMenus` only for a plan of before that has no `menus` list.
  const pdfKids = Array.isArray(kp?.menus?.kids) ? kp!.menus!.kids : kp?.simplifiedMenus?.kids || [];
  const pdfAdultsDiffer = !!kp && adultsDifferOf({ kids: pdfKids, adults: kp.menus?.adults, adultsDiffer: kp.menus?.adultsDiffer });
  // SCRUM-978: an adults' line is marked beside the kids' row of its name only when that row's price
  // cell holds for it too (the same kind of line at the same price each, or the one dish the till
  // charges once); else it prints as its own row, with its own count and price, as the editor shows
  // it and the till charges it.
  const pdfAdults = kitchenAdultsMarks(pdfKids, kp?.menus?.adults ?? [], pdfAdultsDiffer, beoPrintFoldable(extrasCtx));
  const adultsMarkOf = (item: unknown) => {
    const at = (pdfKids as unknown[]).indexOf(item);
    return at >= 0 ? pdfAdults.marks[at] ?? null : null;
  };
  const adultsOnlyRows = pdfAdults.adultsOnly.length > 0
    ? `<table class="menu-table">
        ${pdfAdults.adultsOnly.map((item: any) => menuItemRow({ quantity: item.quantity ?? 1, itemName: item.itemName ?? '', notes: item.notes, price: item.price, included: item.included, source: item.source, productCode: item.productCode }, ADULTS_ONLY_MARK)).join('')}
       </table>`
    : '';
  const adultsLineHtml = kp && kp.required !== false && (pdfKids.length > 0 || kp.setMenuEnabled || pdfAdultsDiffer)
    ? `<p style="font-size:10px;color:#6b7280;margin:4px 0 0;" data-adults="${pdfAdultsDiffer ? 'differ' : 'same'}">Adults: ${
        pdfAdultsDiffer ? 'different for adults — their changes are marked above' : s(ADULTS_SAME_AS_KIDS.toLowerCase())
      }${kp.menus?.adultsFoodTime ? ` &mdash; Service: ${s(kp.menus.adultsFoodTime)}` : ''}</p>`
    : '';

  const kidsMenuHtml = (() => {
    if (!kp) return '';
    const isSetMenuMode = kp.setMenuEnabled;
    const rawKids = pdfKids;
    const kidsFoodTime = kp.menus?.kidsFoodTime;
    if (!rawKids.length && !isSetMenuMode) return '';

    if (isSetMenuMode) {
      const setMenuItems = rawKids.filter((i: any) => i.source === 'set_menu');
      const additionalItems = rawKids.filter((i: any) => i.source !== 'set_menu');
      const selStatus = kp.setMenuSelectionStatus;
      const isSubmitted = selStatus != null ? selStatus.isSubmitted : setMenuItems.length > 0;

      const templateName = kp.setMenuTemplateName || 'Set Menu';
      const received = selStatus?.submittedAt ? parkDayMonthOf(selStatus.submittedAt, parkZone) : '';
      const submittedLabel = received ? ` &mdash; Received ${received}` : '';

      const setMenuBlock = `
        <div style="border:2px solid #6ee7b7;border-radius:6px;overflow:hidden;margin-bottom:8px;">
          <div style="background:#d1fae5;padding:5px 10px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.05em;">Set Menu</span>
            ${isSubmitted
              ? `<span style="font-size:10px;color:#065f46;font-weight:600;">${s(templateName)}${submittedLabel}</span>`
              : `<span style="font-size:10px;color:#92400e;font-weight:600;">${s(templateName)}</span>
                 <span style="font-size:10px;color:#b45309;margin-left:auto;">Awaiting parent selections</span>`
            }
          </div>
          ${setMenuItems.length > 0
            ? `<table class="menu-table" style="margin:0;">
                ${setMenuItems.map((item: any) => `<tr>
                  <td>${s(item.itemName)}${item.notes ? ` ${s(noteInBrackets(item.notes))}` : ''}${adultsMarkHtml(adultsMarkOf(item))}</td>
                  <td class="price-col"><span class="incl-badge" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd;">SET</span></td>
                </tr>`).join('')}
               </table>`
            : `<p style="padding:6px 10px;font-size:10px;color:#6b7280;font-style:italic;margin:0;">No selections yet — parent link sent</p>`
          }
        </div>`;

      const additionalBlock = additionalItems.length > 0
        ? `<h3 style="margin-top:6px;">Additional Items</h3>
           <table class="menu-table">
             ${additionalItems.map((item: any) => {
               const isSet = item.source === 'set_menu';
               const badge = isSet
                 ? '<span class="incl-badge" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd;">SET</span>'
                 : extraBadge(item, 'food');
               return `<tr>
                 <td class="qty">${item.quantity}x</td>
                 <td>${s(item.itemName)}${item.notes ? ` <span class="item-note">${s(noteInBrackets(item.notes))}</span>` : ''}${adultsMarkHtml(adultsMarkOf(item))}</td>
                 <td class="price-col">${badge}</td>
               </tr>`;
             }).join('')}
           </table>`
        : '';

      return `
        <h3>Kids Menu${kidsFoodTime ? ` <span style="font-weight:normal;font-size:11px;color:#666;">&mdash; Service: ${s(kidsFoodTime)}</span>` : ''}</h3>
        ${setMenuBlock}
        ${additionalBlock}`;
    }

    // Regular kids menu (no set menu)
    return `
      <h3>Kids Menu${kidsFoodTime ? ` <span style="font-weight:normal;font-size:11px;color:#666;">&mdash; Service: ${s(kidsFoodTime)}</span>` : ''}</h3>
      <table class="menu-table">
        ${rawKids.map((item) => menuItemRow(item, adultsMarkOf(item))).join('')}
      </table>`;
  })();

  const kitchenHtml = kp ? `
    <div class="section">
      <h2>Kitchen Plan${kp.required === false ? ' <span class="badge-outline">Not Needed</span>' : ''}</h2>
      ${kp.required !== false ? `

      ${kidsMenuHtml}

      ${adultsOnlyRows}

      ${adultsLineHtml}

      ${kp.cakeMode && kp.cakeMode !== 'NONE' ? `
        <h3>Cake</h3>
        <p style="font-size: 11px;">
          ${kp.cakeMode === 'EXTERNAL' ? 'Own cake (guest brings)' : 'Our cake (provided)'}
          ${(kp.cakeQuantity ?? 1) > 1 ? ` <strong>x${kp.cakeQuantity}</strong>` : ''}
          ${kp.cakeIncluded !== undefined ? (kp.cakeIncluded ? ' <span class="incl-badge">INCL</span>' : ` <span class="extra-badge">EXTRA</span>${kp.cakePrice ? ` ${formatCurrency(kp.cakePrice)}` : ''}`) : ''}
          ${kp.cakeTime ? ` &mdash; Time: ${s(kp.cakeTime)}` : ''}
          ${kp.cakeNotes ? ` &mdash; ${s(kp.cakeNotes)}` : ''}
        </p>
      ` : ''}
      ${data.cakeNotes ? `
        <h3>Cake Notes</h3>
        <p style="font-size: 11px;">${s(data.cakeNotes)}</p>
      ` : ''}

      ${kp.notes ? `<p class="notes">${s(kp.notes)}</p>` : ''}
      ` : ''}
    </div>
  ` : '';

  const barHtml = data.barPlan && (data.barPlan.serviceTime || (data.barPlan.items && data.barPlan.items.length > 0)) ? `
    <div class="section">
      <h2>Bar Plan</h2>
      ${data.barPlan.serviceTime ? `<div class="info-item" style="margin-bottom:6px;"><span class="info-label">Service Time:</span><span class="info-value">${s(data.barPlan.serviceTime)}</span></div>` : ''}
      <table class="menu-table">
        ${data.barPlan.items.map(item => `<tr>
          <td class="qty">${item.quantity}x</td>
          <td>${s(item.itemName)}${item.notes ? ` <span class="item-note">${s(noteInBrackets(item.notes))}</span>` : ''}</td>
          <td class="price-col">${item.source === 'set_menu' ? '<span class="incl-badge" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd;">SET</span>' : extraBadge(item, 'bar')}</td>
        </tr>`).join('')}
      </table>
    </div>
  ` : '';

  const timelineHtml = data.timeline?.length ? `
    <div class="section">
      <h2>Timeline</h2>
      <table class="timeline-table">
        <thead>
          <tr>
            <th style="width: 70px;">Time</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          ${[...data.timeline].sort((a, b) => (a.time || '').localeCompare(b.time || '')).map(item => `
            <tr>
              <td style="font-weight: 600;">${s(item.time)}</td>
              <td>${s(item.description)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  const notesSection = [
    data.allergiesNotes ? { title: 'Allergies & Dietary Notes', content: data.allergiesNotes } : null,
    data.specialRequests ? { title: 'Special Requests', content: data.specialRequests } : null,
  ].filter(Boolean) as { title: string; content: string }[];

  const notesHtml = notesSection.length ? `
    <div class="section">
      <h2>Notes</h2>
      ${notesSection.map(n => `
        <div style="margin-bottom: 6px;">
          <p style="font-weight: 600; font-size: 11px; color: #4a5568;">${s(n.title)}</p>
          <p style="font-size: 11px;">${s(n.content)}</p>
        </div>
      `).join('')}
    </div>
  ` : '';

  const logoDataUrl = await getLogoAsDataUrl(data.branchLogoUrl);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      font-size: 11px;
      line-height: 1.5;
      color: #1a202c;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #2d3748;
      padding-bottom: 12px;
      margin-bottom: 18px;
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .logo img { max-height: 50px; max-width: 100px; }
    .branch-info { text-align: right; }
    .branch-name { font-size: 13px; font-weight: 700; color: #2d3748; }
    .branch-address { font-size: 9px; color: #718096; }
    .event-title { font-size: 18px; font-weight: 700; color: #1a202c; margin-bottom: 3px; }
    .event-meta { display: flex; gap: 15px; color: #4a5568; font-size: 11px; align-items: center; }
    .event-datetime { font-size: 22px; font-weight: 900; color: #1a202c; letter-spacing: -0.5px; }
    .status-badge {
      display: inline-block; padding: 1px 6px; background: #ebf8ff;
      color: #2b6cb0; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase;
    }
    .section { margin-bottom: 16px; page-break-inside: avoid; }
    h2 {
      font-size: 12px; font-weight: 700; color: #1a202c; text-transform: uppercase; letter-spacing: 0.5px;
      border-bottom: 1px solid #cbd5e0; padding-bottom: 4px; margin-bottom: 8px;
    }
    h3 {
      font-size: 11px; font-weight: 600; color: #4a5568; margin: 8px 0 4px 0;
    }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; }
    .info-item { display: flex; gap: 4px; font-size: 11px; }
    .info-label { font-weight: 600; color: #4a5568; min-width: 80px; }
    .info-value { color: #1a202c; }
    .info-table { width: 100%; border-collapse: collapse; }
    .info-table td { padding: 3px 8px 3px 0; vertical-align: top; font-size: 11px; }
    .timeline-table { width: 100%; border-collapse: collapse; font-size: 10px; }
    .timeline-table th, .timeline-table td { border: 1px solid #e2e8f0; padding: 4px 8px; text-align: left; }
    .timeline-table th { background: #f7fafc; font-weight: 600; color: #4a5568; font-size: 9px; text-transform: uppercase; }
    .menu-table { width: 100%; border-collapse: collapse; margin: 2px 0 6px 0; }
    .menu-table td { padding: 2px 6px; font-size: 11px; vertical-align: top; }
    .menu-table .qty { width: 35px; font-weight: 600; text-align: right; color: #4a5568; }
    .menu-table .price-col { width: 120px; text-align: right; }
    .price { color: #4a5568; font-size: 10px; }
    .incl-badge { background: #c6f6d5; color: #276749; padding: 0 4px; border-radius: 2px; font-size: 9px; font-weight: 600; }
    .extra-badge { background: #fefcbf; color: #975a16; padding: 0 4px; border-radius: 2px; font-size: 9px; font-weight: 600; }
    .item-note { color: #888; font-size: 10px; font-style: italic; }
    .notes { margin-top: 6px; padding: 6px; background: #f7fafc; border-radius: 3px; font-size: 10px; font-style: italic; }
    .badge-outline { font-size: 9px; color: #718096; border: 1px solid #cbd5e0; padding: 0 4px; border-radius: 2px; margin-left: 6px; }
    .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 8px; color: #a0aec0; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${logoDataUrl ? `<div class="logo"><img src="${logoDataUrl}" alt="Logo" /></div>` : ''}
      <div>
        <div class="event-title">${s(data.eventTitle)}</div>
        <div class="event-meta">
          <span class="event-datetime">${s(formattedDate)} &bull; ${s(formattedTime)}</span>
          ${locationDisplay ? `<span>${s(locationDisplay)}</span>` : ''}
          <span class="status-badge">${s(data.status)}</span>
        </div>
      </div>
    </div>
    <div class="branch-info">
      ${data.branchName ? `<div class="branch-name">${s(data.branchName)}</div>` : ''}
      ${data.branchAddress ? `<div class="branch-address">${s(data.branchAddress)}</div>` : ''}
    </div>
  </div>

  <div class="section">
    <h2>Event Details</h2>
    <div class="info-grid">
      <div class="info-item"><span class="info-label">Date:</span><span class="info-value">${s(formattedDate)}</span></div>
      <div class="info-item"><span class="info-label">Time:</span><span class="info-value">${s(formattedTime)}</span></div>
      ${data.childName ? `<div class="info-item"><span class="info-label">Child:</span><span class="info-value">${s(data.childName)}</span></div>` : ''}
      ${data.bookingName ? `<div class="info-item"><span class="info-label">Booking Name:</span><span class="info-value">${s(data.bookingName)}</span></div>` : ''}
      ${data.parentName ? `<div class="info-item"><span class="info-label">Parent:</span><span class="info-value">${s(data.parentName)}</span></div>` : ''}
      ${data.whatsappPhone ? `<div class="info-item"><span class="info-label">WhatsApp:</span><span class="info-value">${s(data.whatsappPhone)}</span></div>` : ''}
      ${data.kidTurningAge != null ? `<div class="info-item"><span class="info-label">Kid Turning Age:</span><span class="info-value">${data.kidTurningAge}</span></div>` : ''}
      ${data.numChildren ? `<div class="info-item"><span class="info-label">Children:</span><span class="info-value">${data.numChildren}</span></div>` : ''}
      ${data.numAdults ? `<div class="info-item"><span class="info-label">Adults:</span><span class="info-value">${data.numAdults}</span></div>` : ''}
      ${data.programName ? `<div class="info-item"><span class="info-label">Program:</span><span class="info-value">${s(data.programName)}</span></div>` : ''}
      ${data.activities ? `<div class="info-item"><span class="info-label">Activities:</span><span class="info-value">${s(data.activities)}</span></div>` : ''}
      ${data.decoration ? `<div class="info-item"><span class="info-label">Decoration:</span><span class="info-value">${s(data.decoration)}</span></div>` : ''}
      ${locationDisplay ? `<div class="info-item"><span class="info-label">Location:</span><span class="info-value">${s(locationDisplay)}</span></div>` : ''}
    </div>
  </div>

  ${partyHostHtml}
  ${packageHtml}
  ${setupHtml}
  ${kitchenHtml}
  ${barHtml}
  ${timelineHtml}
  ${notesHtml}

  <div class="footer">
    Generated ${parkDateOf(new Date(), parkZone)} &bull; Banquet Event Order
  </div>
</body>
</html>`;
  return html;
}

export async function generateBeoPdf(data: BeoPdfData): Promise<Buffer> {
  const html = await beoPdfHtml(data);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfUint8Array = await page.pdf({
      format: "A4",
      margin: {
        top: "15mm",
        right: "15mm",
        bottom: "15mm",
        left: "15mm",
      },
      printBackground: true,
    });

    return Buffer.from(pdfUint8Array);
  } finally {
    await browser.close();
  }
}
