import { beoQuantityOf } from "@shared/beoQuantity";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import DOMPurify from "isomorphic-dompurify";
import { Readable } from "stream";
import { getFileFromObjectStorage } from "./file-storage";
import { formatParkSignedDate, getLocalDateString } from "./timezone-utils";
import { tillFiguresOf, type TillBillingReading } from "@shared/tillBilling";
import { ADULTS_SAME_AS_KIDS, adultsDifferOf } from "@shared/kitchenAdults";
import {
  beoExtraChargeOf,
  beoExtraHintOf,
  beoExtraPrintWordsOf,
  beoKitchenChargesOf,
  type BeoExtraCharge,
  type BeoExtraContext,
  type BeoExtraLine,
} from "@shared/beoExtras";
import { EXPECTED_EXTRA_LABEL, SOCKS_PRINT_LABEL, expectedExtraWordsOf, socksWordsOf } from "@shared/beoGuestsSocks";
import { beoDishNameOf } from "@shared/beoAdultWaffles";
import { beoPdfTillMoneyHtml } from "./lib/beoPdfMoney";
import {
  STEP_ACTIVITY,
  beoClockOf,
  timelineStepLine,
  untimedBesideTimeline,
  type BeoTimeline,
  type BeoTimelineActivity,
} from "@shared/beoTimeline";

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
  /** SCRUM-1031: the guests the family expects beyond the planned counts, as the party stores them. */
  expectedExtraKids?: number | null;
  expectedExtraAdults?: number | null;
  /** SCRUM-1031: how the socks are paid for (shared/beoGuestsSocks.ts), and the note of "Other / Custom". */
  socksArrangement?: string | null;
  socksNote?: string | null;
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
  /**
   * SCRUM-1027: the party's one timeline as the system makes it (shared/beoTimeline.ts), in order:
   * each step's time, what happens, its few words (what the cake is) and its person.
   */
  timeline?: {
    time: string;
    description: string;
    detail?: string;
    person?: string;
  }[];
  /** SCRUM-1027: the steps with no time and no other part of the page to show them; never given a time. */
  timelineUntimed?: { description: string }[];
  /**
   * SCRUM-1028: the package as the party's own snapshot stores it (beo_package_snapshots), for the
   * header: its name and what it includes. Absent: no package applied.
   */
  packageSnapshot?: {
    packageName?: string | null;
    kidsIncluded?: number | null;
    adultsIncluded?: number | null;
    includedSummary?: string | null;
  };
  /**
   * SCRUM-1028: each Entertainment activity as stored, in the editor's order, with its own person
   * (server/lib/beoTimelineRead.ts, as the timeline reads it), for the print's Entertainment part.
   * (`activities` above is the Event Info's free text of that name.)
   */
  entertainmentActs?: readonly BeoTimelineActivity[];
  branchName?: string;
  branchAddress?: string;
  branchLogoUrl?: string;
}

/**
 * SCRUM-1027: the party's one timeline as the PDF prints it (shared/beoTimeline.ts): each step's
 * time, what happens, its few words and its person, in the order the system made it (a food step
 * says the food is served; its dishes and drinks print once, in the Kitchen and the Bar); and a
 * typed row on a party with no start, which no other part of the page shows, listed, never given a
 * time (an activity with no time says so in the Entertainment part).
 */
export function beoPdfTimelineOf(timeline: BeoTimeline): Pick<BeoPdfData, "timeline" | "timelineUntimed"> {
  return {
    timeline: timeline.steps.map((t) => ({
      time: t.time,
      description: t.label,
      ...(t.detail ? { detail: t.detail } : {}),
      ...(t.person ? { person: t.person } : {}),
    })),
    timelineUntimed: untimedBesideTimeline(timeline).map((u) => ({ description: timelineStepLine(u) })),
  };
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The party's date as the BEO prints it: "16 December '99" (a date that is no yyyy-mm-dd prints as stored). */
function beoEventDateWords(dateStr: string): string {
  const parts = (dateStr || "").split("-");
  if (parts.length !== 3) return dateStr;
  const day = parseInt(parts[2], 10);
  const month = MONTHS[parseInt(parts[1], 10) - 1] || parts[1];
  const yearShort = "'" + parts[0].slice(2);
  return `${day} ${month} ${yearShort}`;
}

/** Text for the page footer, which Chromium draws outside the page's own HTML: escaped here. */
const escapeText = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The fonts every part of the Staff BEO prints in. Thai is named after the Latin faces so a Thai
 * name or note never falls to a box: the app's image installs fonts-thai-tlwg (Loma, Garuda) beside
 * fonts-liberation (Arial's metric twin); Leelawadee UI and Tahoma cover Thai on a Windows desk.
 */
const BEO_FONT_STACK = "'Helvetica Neue', Arial, 'Noto Sans Thai', Loma, Garuda, 'Leelawadee UI', Tahoma, sans-serif";

/**
 * SCRUM-1028: the line Chromium prints at the foot of EVERY page of the Staff BEO: the party, its day
 * and time, and "Page n of m", so a loose second page says whose party it belongs to.
 */
export function beoPdfFooterTemplate(data: Pick<BeoPdfData, "eventTitle" | "eventDate" | "startTime" | "endTime">): string {
  const when = `${beoEventDateWords(data.eventDate)} ${data.startTime || ""}${data.endTime ? ` – ${data.endTime}` : ""}`.trim();
  return `<div style="width: 100%; padding: 0 15mm; font-size: 8px; color: #718096; font-family: ${BEO_FONT_STACK}; display: flex; justify-content: space-between; gap: 12px;">
    <span>Staff BEO &bull; ${escapeText(data.eventTitle || "")} &bull; ${escapeText(when)}</span>
    <span style="white-space: nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}

/**
 * The Staff BEO as HTML, before Chromium prints it: what the page says, for a check to read.
 *
 * SCRUM-1028, the page as the park's operations brief draws it (BEO_COMPARISON.md, the mock-up):
 *   1. the header: the party's name, day, times, room or area and park; who the party is for and
 *      the contact, the planned guests and the hosts, as printed before; and the package box (the
 *      package, what it includes as its snapshot stores it, its lines and the till's money);
 *   2. the ONE timeline the system makes (SCRUM-1027);
 *   3. two columns: KITCHEN on the left (the kids' menu; the adults' menu as their own list when
 *      they eat differently, or one line when they eat the kids'; "Not Needed" when the kitchen is
 *      set so); SETUP, BAR, ENTERTAINMENT, CAKE and NOTES on the right (the whole width when there
 *      is no Kitchen to print).
 * Nothing is invented: every name, count, time, person and amount is the stored BEO's or the
 * till's; a dish with no count is one (beoQuantityOf); prices print where they printed before.
 * Since SCRUM-1030/1031/1042/1050: the header says the socks arrangement and the expected extra
 * guests when the party stores them; the Kitchen opens with its Kitchen Notes; the birthday
 * package's waffles read "Adult Waffles"; a set-menu choice prints its group's label again; a set
 * line whose name carries its count prints no "1x"; an EXTRA the till does not charge carries a
 * mark, its words said once under its list.
 * Long orders run onto the next page row by row: no part is held whole (in either column), a
 * heading never ends a page alone, and every page's foot names the party and its page
 * (beoPdfFooterTemplate). The line
 * saying when the page was made sits under the park's name, where it can never take a page alone.
 */
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
  const asExtraLine = (item: { quantity?: number; itemName?: string; price?: number; source?: string; productCode?: string }): BeoExtraLine =>
    ({ itemName: item.itemName ?? "", quantity: item.quantity ?? 1, price: item.price ?? null, source: item.source ?? null, productCode: item.productCode ?? null });
  const extraBadgeOf = (charge: BeoExtraCharge) => {
    const words = beoExtraPrintWordsOf(charge);
    return `<span class="extra-badge">EXTRA</span>${words ? ` <span class="price">${s(words)}</span>` : ''}`;
  };
  const SET_BADGE = '<span class="incl-badge" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd;">SET</span>';

  const formattedDate = beoEventDateWords(data.eventDate);
  const formattedTime = data.startTime + (data.endTime ? ` – ${data.endTime}` : '');
  const locationDisplay = data.locationText || data.location || '';

  /** One "Label: value" of a grid; nothing for a value that is not there. */
  const fact = (label: string, value: string | number | null | undefined) =>
    value === undefined || value === null || value === ''
      ? ''
      : `<div class="info-item"><span class="info-label">${s(label)}:</span><span class="info-value">${typeof value === 'number' ? value : s(value)}</span></div>`;
  /** A fact across the grid's full width (SCRUM-1031); nothing for a value that is not there. */
  const wideFact = (label: string, value: string | null | undefined) =>
    value ? `<div class="info-item wide"><span class="info-label">${s(label)}:</span><span class="info-value">${s(value)}</span></div>` : '';

  // ── 1. The header ───────────────────────────────────────────────────────────────────────────────
  // The party's facts as the page printed them before (Event Details, Party Host), in one box. The
  // date, time and room print once, in the title band. SCRUM-978: a host line only with a name in it.
  // Read row by row in pairs, as the brief's drawing groups them: the child and the age, the planned
  // children and adults, the host and the backup; then the contact.
  const host = data.partyHost;
  // SCRUM-1031: the socks arrangement as the last fact, the box's full width so a note of "Other /
  // Custom" reads on one line ("Socks arrangement: Birthday Parent Pays"); then the expected extra
  // guests on their own line, marked for reception as the brief's drawing marks it ("+1 child · +6
  // adults"). Information only: nothing is charged from either. Neither stored: nothing prints.
  const socksWords = socksWordsOf(data);
  const expectedExtraWords = expectedExtraWordsOf(data);
  const laterHeaderFacts: string[] = [wideFact(SOCKS_PRINT_LABEL, socksWords)];
  const expectedExtraHtml = expectedExtraWords
    ? `<p class="arrival" data-fact="expected-extra"><span class="info-label">${s(EXPECTED_EXTRA_LABEL)}:</span><span class="info-value">${s(expectedExtraWords)}</span></p>`
    : '';
  const headerFacts = [
    fact('Child', data.childName),
    fact('Kid Turning Age', data.kidTurningAge ?? undefined),
    fact('Children', data.numChildren || undefined),
    fact('Adults', data.numAdults || undefined),
    fact('Party Host', host?.assignedName),
    host?.roleName && !host.assignedName ? fact('Host role', host.roleName) : '',
    fact('Backup', host?.backupName),
    fact('Booking Name', data.bookingName),
    fact('Parent', data.parentName),
    fact('WhatsApp', data.whatsappPhone),
    ...laterHeaderFacts,
  ].filter(Boolean);
  const hostNotesHtml = host?.notes ? `<p class="notes">${s(host.notes)}</p>` : '';
  const factsHtml = headerFacts.length || hostNotesHtml || expectedExtraHtml
    ? `<div class="facts" data-part="party">
        <div class="info-grid">${headerFacts.join('')}</div>
        ${expectedExtraHtml}
        ${hostNotesHtml}
      </div>`
    : '';

  // SCRUM-822: the POS box's money is the till's (server/lib/beoPdfMoney.ts), as on the BEO's screens;
  // Party Details' lines are printed as written, with no price and no sum of the app's own.
  // SCRUM-1028: the box sits in the header beside the party's facts and says what the package
  // includes as its snapshot stores it ("Included: 10 kids + 4 adults, <the package's summary>").
  // The till's money line prints where it printed before (Party Details or the till's figures): a
  // party with only a package snapshot shows the package and what it includes, nothing more.
  const packageHtml = (() => {
    const pd = data.partyDetails;
    const till = tillFiguresOf(data.till);
    const pkg = data.packageSnapshot;
    if (!pd && !till && !pkg) return '';
    const includedItems = pd?.items?.filter(i => i.type === "included") || [];
    const extraItems = pd?.items?.filter(i => i.type === "extra") || [];
    const packageName = pd?.packageName || till?.packageName || pkg?.packageName || '';
    const allowance = [
      pkg?.kidsIncluded != null ? `${pkg.kidsIncluded} kids` : '',
      pkg?.adultsIncluded != null ? `${pkg.adultsIncluded} adults` : '',
    ].filter(Boolean).join(' + ');
    const included = [allowance, pkg?.includedSummary?.trim() ?? ''].filter(Boolean).join(', ');

    return `
      <div class="pos-box" data-part="package">
        <h2>POS${packageName ? `: ${s(packageName)}` : ''}</h2>
        ${included ? `<p class="pkg-included">Included: ${s(included)}</p>` : ''}
        ${includedItems.length ? `
          <h3>Included</h3>
          <table class="menu-table pos-table">
            ${includedItems.map(item => `<tr>
              <td>${s(item.label || item.description)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
              <td class="badge-col"><span class="incl-badge">INCL</span></td>
            </tr>`).join('')}
          </table>
        ` : ''}
        ${extraItems.length ? `
          <h3>Extras</h3>
          <table class="menu-table pos-table">
            ${extraItems.map(item => `<tr>
              <td>${s(item.label || item.description)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
              <td class="badge-col"><span class="extra-badge">EXTRA</span></td>
            </tr>`).join('')}
          </table>
        ` : ''}
        ${pd || till ? beoPdfTillMoneyHtml(data.till, pd?.depositDate) : ''}
        ${pd?.notes ? `<p class="notes">${s(pd.notes)}</p>` : ''}
      </div>
    `;
  })();

  // ── 2. The one timeline ─────────────────────────────────────────────────────────────────────────
  // SCRUM-1027: the one timeline, in the order the system made it (equal times: party, food,
  // activity, other); a sort by the clock alone keeps that order. A step's person and its few words
  // (what the cake is) print beside it; the dishes and drinks are not repeated here, the Kitchen and
  // the Bar list them. A typed step with no time is listed under it, never given one.
  const timelineUntimed = data.timelineUntimed ?? [];
  const timelineHtml = data.timeline?.length || timelineUntimed.length ? `
    <div class="part timeline-part" data-part="timeline">
      <h2>Timeline</h2>
      ${data.timeline?.length ? `
      <table class="timeline-table">
        <colgroup><col style="width: 52px;" /><col /></colgroup>
        <thead>
          <tr>
            <th>Time</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          ${[...data.timeline].sort((a, b) => (a.time || '').localeCompare(b.time || '')).map(item => `
            <tr>
              <td style="font-weight: 600;">${s(item.time)}</td>
              <td>${s(item.description)}${item.detail ? ` <span class="item-note">${s(item.detail)}</span>` : ''}${item.person ? ` <span class="item-note">· ${s(item.person)}</span>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ` : ''}
      ${timelineUntimed.length ? `<p class="notes" data-timeline-untimed>No time set: ${timelineUntimed.map(u => s(u.description)).join('; ')}</p>` : ''}
    </div>
  ` : '';

  // ── 3. Kitchen, the left column ─────────────────────────────────────────────────────────────────
  // SCRUM-958 (SCRUM-940 point 3): a line's note in brackets, once: a set-menu choice's note is
  // already its group in brackets ("(Pizza)", the parent link's and the approval's mark), so it
  // printed "Margherita ((Pizza))".
  const noteInBrackets = (note: string) => {
    const t = note.trim();
    return t.startsWith('(') && t.includes(')') ? t : `(${t})`;
  };

  type FoodLine = { quantity?: number; itemName?: string; notes?: string; price?: number; included?: boolean; source?: string; productCode?: string; groupId?: string };
  // SCRUM-1050 (R24, the owner's answer of 19 November): an EXTRA line the till does not charge
  // (no price entered and no till code: "Price unresolved - not charged") carries a small mark
  // beside its badge instead of those words, and the words print ONCE under the list that has
  // such lines (the Kitchen, the Bar), beside the mark. When a line counts so is the editor's own
  // rule, unchanged (shared/beoExtras.ts), and nothing about what is charged changes.
  const UNRESOLVED_MARK = '*';
  const unresolvedWords = beoExtraHintOf({ kind: "not_charged", why: "no_price" }) ?? '';
  const unresolvedIn = { food: false, bar: false };
  const unresolvedNote = (area: "food" | "bar") => unresolvedIn[area]
    ? `<p class="mark-note" data-unresolved-note><span class="mark">${UNRESOLVED_MARK}</span> ${s(unresolvedWords)}</p>`
    : '';
  // SCRUM-1050: a set-menu line whose stored name already carries its count ("French fries x3",
  // the set menu's own label) and that holds no count of its own (none stored, or the 1 every
  // writer stores when the set menu names none: resolveSetMenuLines, beoQuantityOf) prints with no
  // "1x" before it; every other line with no count still prints 1x, and a set line with a count of
  // its own above one prints it as stored.
  const COUNT_IN_NAME = /(?:^\d+\s?[x×]\s|\s[x×]\s?\d+$)/i;
  const countInName = (item: FoodLine) =>
    item.source === 'set_menu' && beoQuantityOf(item.quantity) === 1 && COUNT_IN_NAME.test((item.itemName ?? '').trim());
  // One dish: its count (none stored is one, the owner's answer), its name as stored, its note, and
  // its badge with the price words it printed before (SCRUM-906/970: an EXTRA's price for each item).
  // SCRUM-1050 (R13, the owner's answer of 19 November): a set-menu choice prints its group's label
  // beside it again, "Margherita (Pizza 2)", as the print did before 19 November (SCRUM-958: in one
  // pair of brackets). SCRUM-1042: the birthday package's waffles read "Adult Waffles" here
  // (shared/beoAdultWaffles.ts); the stored line keeps its name.
  const foodRow = (item: FoodLine, area: "food" | "bar", charge?: BeoExtraCharge) => {
    const isSet = item.source === 'set_menu';
    const rawNote = item.notes?.trim() ?? '';
    const note = rawNote
      ? isSet && area === 'food'
        ? ` ${s(noteInBrackets(rawNote))}`
        : ` <span class="item-note">${s(noteInBrackets(rawNote))}</span>`
      : '';
    const name = area === 'food' ? beoDishNameOf(item) : (item.itemName ?? '');
    const lineCharge = isSet ? null : charge ?? beoExtraChargeOf(asExtraLine(item), area, extrasCtx);
    const unresolved = lineCharge?.kind === 'not_charged';
    if (unresolved) unresolvedIn[area] = true;
    return `<tr>
      <td class="qty">${countInName(item) ? '' : `${beoQuantityOf(item.quantity)}x`}</td>
      <td class="dish">${s(name)}${note}</td>
      <td class="price-col">${isSet ? SET_BADGE : unresolved ? `<span class="extra-badge">EXTRA</span><span class="mark">${UNRESOLVED_MARK}</span>` : extraBadgeOf(lineCharge!)}</td>
    </tr>`;
  };
  const foodTable = (lines: FoodLine[], area: "food" | "bar", style = '', charges?: readonly BeoExtraCharge[]) =>
    `<table class="menu-table"${style ? ` style="${style}"` : ''}>
      <colgroup><col class="qty-col" /><col /><col class="price-col-w" /></colgroup>
      ${lines.map((l, at) => foodRow(l, area, charges?.[at])).join('')}
    </table>`;
  const serviceWords = (time: string | undefined) => time ? ` <span class="svc">&mdash; Service: ${s(time)}</span>` : '';

  const kp = data.kitchenPlan;
  // SCRUM-978: the kids' list the editor and the till read: `menus` (canonical, kitchenPlanDbDataOf in
  // beo-routes.ts), `simplifiedMenus` only for a plan of before that has no `menus` list.
  const pdfKids: FoodLine[] = (Array.isArray(kp?.menus?.kids) ? kp!.menus!.kids : kp?.simplifiedMenus?.kids || [])
    .map(item => ({ ...item, quantity: beoQuantityOf("quantity" in item ? item.quantity : undefined) }));
  const pdfAdultLines: FoodLine[] = (kp?.menus?.adults ?? []).map(item => ({ ...item, quantity: beoQuantityOf(item.quantity) }));
  // SCRUM-829's switch as its readers resolve it (shared/kitchenAdults.ts). SCRUM-1028, the owner's
  // answer: when the adults eat differently they print as their OWN list with their own counts (no
  // longer marked beside the kids' rows); "Same as kids" keeps them in the kids' rows, said in one line.
  const pdfAdultsDiffer = !!kp && adultsDifferOf({ kids: pdfKids, adults: pdfAdultLines, adultsDiffer: kp.menus?.adultsDiffer });
  // Each adults' line's price words as the editor and the till have them (shared/beoExtras.ts): a
  // line that is the same dish as a kids' line (name, count, code) is charged once, with the kids'
  // line, and says so; any other at its own price.
  const adultsCharges = beoKitchenChargesOf(pdfKids.map(asExtraLine), pdfAdultLines.map(asExtraLine), pdfAdultsDiffer, extrasCtx).adults;
  const foodNeeded = !!kp && kp.required !== false;

  const kidsMenuHtml = (() => {
    if (!kp || !foodNeeded) return '';
    const isSetMenuMode = kp.setMenuEnabled;
    const kidsFoodTime = kp.menus?.kidsFoodTime;
    if (!pdfKids.length && !isSetMenuMode) return '';
    const heading = `<h3>Kids Menu${data.numChildren ? ` (${data.numChildren} kids)` : ''}${serviceWords(kidsFoodTime)}</h3>`;

    if (!isSetMenuMode) return `${heading}${foodTable(pdfKids, 'food')}`;

    const setMenuItems = pdfKids.filter((i) => i.source === 'set_menu');
    const additionalItems = pdfKids.filter((i) => i.source !== 'set_menu');
    const selStatus = kp.setMenuSelectionStatus;
    const isSubmitted = selStatus != null ? selStatus.isSubmitted : setMenuItems.length > 0;
    const templateName = kp.setMenuTemplateName || 'Set Menu';
    const received = selStatus?.submittedAt ? parkDayMonthOf(selStatus.submittedAt, parkZone) : '';
    const submittedLabel = received ? ` &mdash; Received ${received}` : '';

    const setMenuBlock = `
      <div class="set-box">
        <div class="set-head">
          <span class="set-kind">Set Menu</span>
          ${isSubmitted
            ? `<span style="color:#065f46;">${s(templateName)}${submittedLabel}</span>`
            : `<span style="color:#92400e;">${s(templateName)}</span>
               <span style="color:#b45309;margin-left:auto;">Awaiting parent selections</span>`
          }
        </div>
        ${setMenuItems.length > 0
          ? foodTable(setMenuItems, 'food', 'margin:0;')
          : `<p class="set-empty">No selections yet — parent link sent</p>`
        }
      </div>`;
    const additionalBlock = additionalItems.length > 0
      ? `<h3 style="margin-top:6px;">Additional Items</h3>${foodTable(additionalItems, 'food')}`
      : '';
    return `${heading}${setMenuBlock}${additionalBlock}`;
  })();

  const adultsHtml = (() => {
    if (!kp || !foodNeeded) return '';
    const adultsFoodTime = kp.menus?.adultsFoodTime;
    if (pdfAdultsDiffer) {
      return `<h3 data-adults="differ">Adults Menu${data.numAdults ? ` (${data.numAdults} adults)` : ''}${serviceWords(adultsFoodTime)}</h3>
        ${pdfAdultLines.length ? foodTable(pdfAdultLines, 'food', '', adultsCharges) : '<p class="plain">No dishes listed for the adults.</p>'}`;
    }
    if (!pdfKids.length && !kp.setMenuEnabled) return '';
    return `<p class="adults-same" data-adults="same">Adults: ${s(ADULTS_SAME_AS_KIDS.toLowerCase())}${adultsFoodTime ? ` &mdash; Service: ${s(adultsFoodTime)}` : ''}</p>`;
  })();

  // The kitchen set to Not Needed says so, in the words it printed before ("Kitchen Plan  Not
  // Needed"): the stored fact. No kitchen plan, or one with nothing on it, prints no Kitchen at all
  // (SCRUM-978: a part with nothing in it prints no heading): the BEO does not store that no food
  // was ordered, and a party whose menu is not entered yet must not tell the kitchen so.
  const kitchenNotNeeded = !!kp && !foodNeeded;
  // SCRUM-1030, the brief: the Kitchen Notes (the plan's own field, typed in the editor's Food &
  // Drinks or on the Day-of view) print at the very top of the Kitchen, before the menus, as
  // written, and only with the kitchen needed, as before. Empty: nothing.
  const kitchenNotesText = foodNeeded && kp?.notes?.trim() ? kp.notes : '';
  const kitchenNotes = kitchenNotesText
    ? `<p class="notes kitchen-notes" data-kitchen-notes><span class="note-label">Kitchen Notes:</span> ${s(kitchenNotesText)}</p>`
    : '';
  const kitchenHtml = kitchenNotNeeded || kidsMenuHtml || adultsHtml || kitchenNotes ? `
    <div class="part kitchen-part" data-part="kitchen">
      <h2>Kitchen${kitchenNotNeeded ? ' <span class="badge-outline" data-no-food>Not Needed</span>' : ''}</h2>
      ${kitchenNotes}
      ${kidsMenuHtml}
      ${adultsHtml}
      ${unresolvedNote('food')}
    </div>` : '';

  // ── 4. The right column: Setup, Bar, Entertainment, Cake, Notes ─────────────────────────────────
  // SCRUM-978: a part with nothing to print prints no heading.
  const setup = data.setupPlan;
  const setupHasText = !!setup && !!(setup.readyBy || setup.responsible || setup.tasks?.length || setup.notes);
  const setupHtml = setupHasText || data.decoration ? `
    <div class="part box" data-part="setup">
      <h2>Setup</h2>
      <div class="info-grid one">
        ${fact('Ready By', setup?.readyBy)}
        ${fact('Who', setup?.responsible)}
        ${fact('Decoration', data.decoration)}
      </div>
      ${setup?.tasks?.length ? `
        <table class="timeline-table" style="margin-top: 4px;">
          <thead>
            <tr>
              <th>Task</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${setup.tasks.map(task => `
              <tr>
                <td>${s(task.itemLabel)}</td>
                <td>${task.notes ? s(task.notes) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}
      ${setup?.notes ? `<p class="notes">${s(setup.notes)}</p>` : ''}
    </div>
  ` : '';

  const bar = data.barPlan;
  const barItems = bar?.items ?? [];
  const barHtml = bar && (bar.serviceTime || barItems.length > 0) ? `
    <div class="part box" data-part="bar">
      <h2>Bar</h2>
      ${bar.serviceTime ? `<div class="info-item" style="margin-bottom:4px;"><span class="info-label">Service Time:</span><span class="info-value">${s(bar.serviceTime)}</span></div>` : ''}
      ${barItems.length ? foodTable(barItems, 'bar') : ''}
      ${barItems.length ? unresolvedNote('bar') : ''}
    </div>
  ` : '';

  // Each activity as stored, in the editor's order: its time (none stored: said so, never given
  // one), its name (the timeline's own words for an act with none) and its own person.
  // The Program and the Activities text of Event Info print here (they printed in Event Details).
  const acts = data.entertainmentActs ?? [];
  // The person's column only when an act names one (nothing writes a person on an act yet: SCRUM-1032).
  const actsHavePeople = acts.some((a) => !!a.person?.trim());
  const entertainmentHtml = acts.length || data.programName || data.activities ? `
    <div class="part box" data-part="entertainment">
      <h2>Entertainment</h2>
      ${acts.length ? `
        <table class="timeline-table">
          <colgroup><col style="width: 66px;" /><col />${actsHavePeople ? '<col style="width: 34%;" />' : ''}</colgroup>
          <tbody>
            ${acts.map((a) => {
              const raw = typeof a.startTime === 'string' ? a.startTime.trim() : '';
              const time = beoClockOf(raw)?.time ?? raw;
              return `<tr>
                <td style="font-weight: 600;">${time ? s(time) : '<span class="item-note" style="white-space: nowrap;">No time set</span>'}</td>
                <td>${s(a.customName?.trim() || STEP_ACTIVITY)}</td>
                ${actsHavePeople ? `<td>${a.person?.trim() ? s(a.person.trim()) : ''}</td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      ` : ''}
      <div class="info-grid one" style="margin-top: 4px;">
        ${fact('Program', data.programName)}
        ${fact('Activities', data.activities)}
      </div>
    </div>
  ` : '';

  // The cake has its own part (it printed inside the kitchen before): what it is, how many, INCL or
  // EXTRA with the price it printed with, its time and its notes; and the event's own cake notes.
  // Shown when it showed before: with a kitchen plan whose kitchen is needed (the editor hides the
  // cake when the kitchen is Not Needed). The timeline keeps the cake moment, as it always has.
  const hasCake = foodNeeded && !!kp?.cakeMode && kp.cakeMode !== 'NONE';
  const eventCakeNotes = foodNeeded ? data.cakeNotes : undefined;
  const cakeHtml = hasCake || eventCakeNotes ? `
    <div class="part box" data-part="cake">
      <h2>Cake</h2>
      ${hasCake && kp ? `
        <p>
          ${kp.cakeMode === 'EXTERNAL' ? 'Own cake (guest brings)' : 'Our cake (provided)'}
          ${(kp.cakeQuantity ?? 1) > 1 ? ` <strong>x${kp.cakeQuantity}</strong>` : ''}
          ${kp.cakeIncluded !== undefined ? (kp.cakeIncluded ? ' <span class="incl-badge">INCL</span>' : ` <span class="extra-badge">EXTRA</span>${kp.cakePrice ? ` ${formatCurrency(kp.cakePrice)}` : ''}`) : ''}
          ${kp.cakeTime ? ` &mdash; Time: ${s(kp.cakeTime)}` : ''}
          ${kp.cakeNotes ? ` &mdash; ${s(kp.cakeNotes)}` : ''}
        </p>
      ` : ''}
      ${eventCakeNotes ? `<p class="notes"><strong>Cake Notes:</strong> ${s(eventCakeNotes)}</p>` : ''}
    </div>
  ` : '';

  // The notes as written: a note may carry an amount the family agreed (the owner's answer).
  const notesSection = [
    data.allergiesNotes ? { title: 'Allergies & Dietary Notes', content: data.allergiesNotes } : null,
    data.specialRequests ? { title: 'Special Requests', content: data.specialRequests } : null,
  ].filter(Boolean) as { title: string; content: string }[];
  const notesHtml = notesSection.length ? `
    <div class="part box" data-part="notes">
      <h2>Notes</h2>
      ${notesSection.map(n => `
        <div class="note-block">
          <p class="note-title">${s(n.title)}</p>
          <p class="note-text">${s(n.content)}</p>
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
      font-family: ${BEO_FONT_STACK};
      font-size: 11px;
      line-height: 1.25;
      color: #1a202c;
    }
    td, p, .info-value, h3 { overflow-wrap: break-word; word-break: normal; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      border-bottom: 2px solid #2d3748;
      padding-bottom: 8px;
      margin-bottom: 8px;
    }
    .header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .logo img { max-height: 50px; max-width: 100px; }
    .branch-info { text-align: right; flex: 0 0 auto; max-width: 35%; }
    .branch-name { font-size: 13px; font-weight: 700; color: #2d3748; }
    .branch-address { font-size: 9px; color: #718096; }
    .event-title { font-size: 18px; font-weight: 700; color: #1a202c; margin-bottom: 3px; }
    .event-meta { display: flex; flex-wrap: wrap; column-gap: 15px; row-gap: 2px; color: #4a5568; font-size: 11px; align-items: center; }
    .event-datetime { font-size: 20px; font-weight: 900; color: #1a202c; letter-spacing: -0.5px; }
    .status-badge {
      display: inline-block; padding: 1px 6px; background: #ebf8ff;
      color: #2b6cb0; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase;
    }
    .header-band { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 8px; }
    .facts { flex: 1 1 0; min-width: 0; border: 1px solid #cbd5e0; border-radius: 4px; padding: 6px 8px; break-inside: avoid; }
    .pos-box { flex: 0 0 44%; min-width: 0; border: 1px solid #cbd5e0; border-radius: 4px; padding: 6px 8px; background: #f7fafc; break-inside: avoid; }
    .header-band > .pos-box:only-child { flex: 1 1 auto; }
    .pkg-included { font-size: 10px; color: #4a5568; background: #edf2f7; border-radius: 3px; padding: 2px 6px; margin-bottom: 4px; }
    .part { margin-bottom: 8px; }
    .box { break-inside: auto; }
    .badge-outline { font-size: 9px; font-weight: 600; color: #718096; border: 1px solid #cbd5e0; padding: 0 4px; border-radius: 2px; margin-left: 6px; text-transform: none; letter-spacing: 0; }
    h2 {
      font-size: 12px; font-weight: 700; color: #1a202c; text-transform: uppercase; letter-spacing: 0.5px;
      border-bottom: 1px solid #cbd5e0; padding-bottom: 2px; margin-bottom: 4px;
      break-after: avoid; page-break-after: avoid;
    }
    .pos-box h2 { font-size: 11px; margin-bottom: 4px; }
    h3 {
      font-size: 11px; font-weight: 600; color: #4a5568; margin: 6px 0 3px 0;
      break-after: avoid; page-break-after: avoid;
    }
    .svc { font-weight: normal; font-size: 10px; color: #666; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px; }
    .info-grid.one { grid-template-columns: 1fr; }
    .info-grid .wide { grid-column: 1 / -1; }
    .info-item { font-size: 11px; min-width: 0; }
    .info-label { font-weight: 600; color: #4a5568; margin-right: 4px; }
    .info-value { color: #1a202c; }
    .info-table { width: 100%; border-collapse: collapse; }
    .info-table td { padding: 2px 8px 2px 0; vertical-align: top; font-size: 11px; }
    .timeline-table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
    .timeline-table th, .timeline-table td { border: 1px solid #e2e8f0; padding: 2px 6px; text-align: left; vertical-align: top; }
    .timeline-table th { background: #f7fafc; font-weight: 600; color: #4a5568; font-size: 9px; text-transform: uppercase; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    .menu-table { width: 100%; border-collapse: collapse; margin: 2px 0 6px 0; table-layout: fixed; }
    .menu-table td { padding: 1px 4px; font-size: 11px; vertical-align: top; }
    .menu-table .qty-col { width: 30px; }
    .menu-table .price-col-w { width: 40%; }
    .col-right .menu-table .price-col-w { width: 46%; }
    .menu-table .qty { font-weight: 600; text-align: right; color: #4a5568; }
    .menu-table .price-col { text-align: right; }
    .pos-table .badge-col { width: 56px; text-align: right; }
    .price { color: #4a5568; font-size: 10px; }
    .incl-badge, .extra-badge { white-space: nowrap; }
    .incl-badge { background: #c6f6d5; color: #276749; padding: 0 4px; border-radius: 2px; font-size: 9px; font-weight: 600; }
    .extra-badge { background: #fefcbf; color: #975a16; padding: 0 4px; border-radius: 2px; font-size: 9px; font-weight: 600; }
    .item-note { color: #888; font-size: 10px; font-style: italic; }
    .notes { margin-top: 4px; padding: 4px 6px; background: #f7fafc; border-radius: 3px; font-size: 10px; font-style: italic; white-space: pre-wrap; }
    .kitchen-notes { margin: 0 0 4px 0; font-size: 11px; }
    .note-label { font-weight: 600; font-style: normal; color: #4a5568; }
    .arrival { margin-top: 4px; padding: 2px 6px; background: #fffbeb; border: 1px solid #f6e05e; border-radius: 3px; font-size: 11px; }
    .mark { color: #975a16; font-weight: 700; font-size: 10px; margin-left: 2px; }
    .mark-note { font-size: 9px; color: #718096; margin: 0 0 6px 0; break-before: avoid; page-break-before: avoid; }
    .plain { font-size: 11px; color: #4a5568; }
    .adults-same { font-size: 10px; color: #6b7280; margin: 4px 0 0; }
    .set-box { border: 2px solid #6ee7b7; border-radius: 6px; overflow: hidden; margin-bottom: 6px; }
    .set-head { background: #d1fae5; padding: 4px 8px; display: flex; align-items: center; gap: 8px; font-size: 10px; font-weight: 600; break-after: avoid; }
    .set-kind { font-weight: 700; color: #065f46; text-transform: uppercase; letter-spacing: 0.05em; }
    .set-empty { padding: 5px 8px; font-size: 10px; color: #6b7280; font-style: italic; }
    .note-block { margin-bottom: 4px; }
    .note-title { font-weight: 600; font-size: 10px; color: #4a5568; break-after: avoid; }
    .note-text { font-size: 11px; white-space: pre-wrap; }
    .columns { display: flex; gap: 14px; align-items: flex-start; }
    .col-left { flex: 0 0 50%; min-width: 0; }
    .col-right { flex: 1 1 0; min-width: 0; }
    .generated { font-size: 8px; color: #a0aec0; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${logoDataUrl ? `<div class="logo"><img src="${logoDataUrl}" alt="Logo" /></div>` : ''}
      <div style="min-width: 0;">
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
      <div class="generated">Generated ${parkDateOf(new Date(), parkZone)} &bull; Banquet Event Order</div>
    </div>
  </div>

  ${factsHtml || packageHtml ? `<div class="header-band">${factsHtml}${packageHtml}</div>` : ''}

  ${timelineHtml}

  <div class="columns">
    ${kitchenHtml ? `<div class="col-left">
      ${kitchenHtml}
    </div>` : ''}
    <div class="col-right">
      ${setupHtml}
      ${barHtml}
      ${entertainmentHtml}
      ${cakeHtml}
      ${notesHtml}
    </div>
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

    // SCRUM-1028: every page's foot names the party and its page ("Page 2 of 3"), so a loose
    // second page of a long order is known; the bottom margin leaves it room.
    const pdfUint8Array = await page.pdf({
      format: "A4",
      margin: {
        top: "15mm",
        right: "15mm",
        bottom: "18mm",
        left: "15mm",
      },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: beoPdfFooterTemplate(data),
    });

    return Buffer.from(pdfUint8Array);
  } finally {
    await browser.close();
  }
}
