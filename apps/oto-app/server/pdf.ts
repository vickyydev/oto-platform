import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import DOMPurify from "isomorphic-dompurify";

const PDF_DIR = path.join(process.cwd(), "pdfs");

if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

// Convert a local file path or relative URL to a base64 data URL for embedding in PDF
function getLogoAsDataUrl(logoUrl: string | undefined): string | undefined {
  if (!logoUrl) return undefined;
  
  // If already a data URL, return as is
  if (logoUrl.startsWith('data:')) return logoUrl;
  
  try {
    // Convert relative URL to file path
    const relativePath = logoUrl.replace(/^\//, '');
    const filePath = path.join(process.cwd(), relativePath);
    
    if (!fs.existsSync(filePath)) {
      console.error(`Logo file not found: ${filePath}`);
      return undefined;
    }
    
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    
    // Detect mime type from extension
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.svg') mimeType = 'image/svg+xml';
    else if (ext === '.webp') mimeType = 'image/webp';
    
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error(`Failed to convert logo to data URL: ${error}`);
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

export function wrapContentInDocument(
  content: string, 
  branchHeader?: { name: string; address: string; logoUrl?: string },
  options?: { appendSignatureSection?: boolean }
): string {
  if (content.trim().toLowerCase().startsWith('<!doctype')) {
    return DOMPurify.sanitize(content, { WHOLE_DOCUMENT: true });
  }
  
  const sanitizedContent = DOMPurify.sanitize(content);

  // Build header HTML based on what's available
  let headerHtml = '';
  if (branchHeader && (branchHeader.logoUrl || branchHeader.name || branchHeader.address)) {
    // Convert logo URL to data URL for PDF embedding
    const logoDataUrl = getLogoAsDataUrl(branchHeader.logoUrl);
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

export async function generatePdf(html: string, contractId: string, branchHeader?: { name: string; address: string; logoUrl?: string }): Promise<string> {
  // Include blank signature section for unsigned contracts
  const wrappedHtml = wrapContentInDocument(html, branchHeader, { appendSignatureSection: true });
  
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(wrappedHtml, { waitUntil: "networkidle0" });

    const pdfFileName = `contract_${contractId}.pdf`;
    const pdfPath = path.join(PDF_DIR, pdfFileName);

    await page.pdf({
      path: pdfPath,
      format: "A4",
      margin: {
        top: "20mm",
        right: "20mm",
        bottom: "20mm",
        left: "20mm",
      },
      printBackground: true,
    });

    return pdfPath;
  } finally {
    await browser.close();
  }
}

export function getPdfPath(contractId: string): string {
  return path.join(PDF_DIR, `contract_${contractId}.pdf`);
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

function formatDateDDMMYYYY(date: Date): string {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
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
  const signedDateStr = formatDateDDMMYYYY(signedAt);
  
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
  const wrappedHtml = wrapContentInDocument(contentWithSignature, branchHeader, { appendSignatureSection: false });

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

export async function generateSignedPdfToFile(
  html: string,
  contractId: string,
  signatureName: string,
  signedAt: Date,
  branchHeader?: { name: string; address: string; logoUrl?: string },
  signatureImage?: string,
  employerSignatureData?: { name: string; title: string; image: string; date: string }
): Promise<string> {
  const pdfBuffer = await generateSignedPdf(html, contractId, signatureName, signedAt, branchHeader, signatureImage, employerSignatureData);
  
  const pdfFileName = `signed_contract_${contractId}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfFileName);
  fs.writeFileSync(pdfPath, pdfBuffer);
  
  return pdfPath;
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
  const signedDateStr = formatDateDDMMYYYY(signedAt);
  
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

  const wrappedHtml = wrapContentInDocument(contentWithSignature, branchHeader, { appendSignatureSection: false });

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
      kids?: { quantity: number; itemName: string; notes?: string; price?: number; included?: boolean; source?: string }[];
      adults?: { quantity: number; itemName: string; notes?: string; price?: number; included?: boolean; source?: string }[];
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
    items?: { quantity: number; itemName: string; notes?: string; source?: string }[];
  };
  partyDetails?: {
    packageName?: string;
    packageBasePrice?: number;
    items?: { id?: string; label: string; type: string; price: number; notes?: string }[];
    prepaymentReceived?: number;
    depositDate?: string;
    notes?: string;
  };
  timeline?: {
    time: string;
    description: string;
  }[];
  branchName?: string;
  branchAddress?: string;
  branchLogoUrl?: string;
}

export async function generateBeoPdf(data: BeoPdfData): Promise<Buffer> {
  const formatCurrency = (amount: number) => `${amount.toLocaleString()}฿`;
  const s = (str: string) => DOMPurify.sanitize(str);

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

  const partyHostHtml = data.partyHost ? `
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

  const packageHtml = (() => {
    const pd = data.partyDetails;
    if (!pd) return '';
    const includedItems = pd.items?.filter(i => i.type === "included") || [];
    const extraItems = pd.items?.filter(i => i.type === "extra") || [];
    const extrasTotal = extraItems.reduce((sum, i) => sum + (i.price || 0), 0);
    const packageTotal = (pd.packageBasePrice || 0) + extrasTotal;
    const outstandingBalance = packageTotal - (pd.prepaymentReceived || 0);

    return `
      <div class="section">
        <h2>POS${pd.packageName ? `: ${s(pd.packageName)}` : ''}</h2>
        ${pd.packageBasePrice ? `<div class="info-item" style="margin-bottom: 6px;"><span class="info-label">Base Price:</span><span class="info-value" style="font-weight: 700;">${formatCurrency(pd.packageBasePrice)}</span></div>` : ''}
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
              <td class="price-col"><span class="extra-badge">EXTRA</span> <span class="price">${formatCurrency(item.price)}</span></td>
            </tr>`).join('')}
          </table>
        ` : ''}
        <table class="info-table" style="margin-top: 8px;">
          <tr><td style="font-weight: 600;">POS Total:</td><td style="font-weight: 700;">${formatCurrency(packageTotal)}</td></tr>
          ${pd.prepaymentReceived ? `<tr><td>Prepayment Received:</td><td style="color: #38a169;">-${formatCurrency(pd.prepaymentReceived)}</td></tr>` : ''}
          ${pd.depositDate ? `<tr><td>Deposit Date:</td><td>${s(pd.depositDate)}</td></tr>` : ''}
          ${pd.prepaymentReceived ? `<tr><td style="font-weight: 600;">Outstanding Balance:</td><td style="font-weight: 700; ${outstandingBalance > 0 ? 'color: #e53e3e;' : 'color: #38a169;'}">${formatCurrency(outstandingBalance)}</td></tr>` : ''}
        </table>
        ${pd.notes ? `<p class="notes">${s(pd.notes)}</p>` : ''}
      </div>
    `;
  })();

  const setupHtml = data.setupPlan ? `
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

  const menuItemRow = (item: { quantity: number; itemName: string; notes?: string; price?: number; included?: boolean; source?: string }) => {
    const isSet = item.source === 'set_menu';
    const badge = isSet
      ? '<span class="incl-badge" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd;">SET</span>'
      : `<span class="extra-badge">EXTRA</span>${item.price ? ` <span class="price">${formatCurrency(item.price)}</span>` : ''}`;
    return `<tr>
      <td class="qty">${item.quantity}x</td>
      <td>${s(item.itemName)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
      <td class="price-col">${badge}</td>
    </tr>`;
  };

  const kp = data.kitchenPlan;

  const kidsMenuHtml = (() => {
    if (!kp) return '';
    const isSetMenuMode = kp.setMenuEnabled;
    const rawKids = kp.simplifiedMenus?.kids || kp.menus?.kids || [];
    const kidsFoodTime = kp.menus?.kidsFoodTime;
    if (!rawKids.length && !isSetMenuMode) return '';

    if (isSetMenuMode) {
      const setMenuItems = rawKids.filter((i: any) => i.source === 'set_menu');
      const additionalItems = rawKids.filter((i: any) => i.source !== 'set_menu');
      const selStatus = kp.setMenuSelectionStatus;
      const isSubmitted = selStatus != null ? selStatus.isSubmitted : setMenuItems.length > 0;

      const templateName = kp.setMenuTemplateName || 'Set Menu';
      const submittedLabel = selStatus?.submittedAt
        ? ` &mdash; Received ${new Date(selStatus.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
        : '';

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
                  <td>${s(item.itemName)}${item.notes ? ` (${s(item.notes)})` : ''}</td>
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
                 : `<span class="extra-badge">EXTRA</span>${item.price ? ` <span class="price">${formatCurrency(item.price)}</span>` : ''}`;
               return `<tr>
                 <td class="qty">${item.quantity}x</td>
                 <td>${s(item.itemName)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
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
        ${rawKids.map(menuItemRow).join('')}
      </table>`;
  })();

  const kitchenHtml = kp ? `
    <div class="section">
      <h2>Kitchen Plan${kp.required === false ? ' <span class="badge-outline">Not Needed</span>' : ''}</h2>
      ${kp.required !== false ? `

      ${kidsMenuHtml}

      ${kp.menus?.adults?.length ? `
        <h3>Adults Menu${kp.menus.adultsFoodTime ? ` <span style="font-weight:normal;font-size:11px;color:#666;">&mdash; Service: ${s(kp.menus.adultsFoodTime)}</span>` : ''}</h3>
        <table class="menu-table">
          ${kp.menus.adults.map(menuItemRow).join('')}
        </table>
      ` : ''}

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
          <td>${s(item.itemName)}${item.notes ? ` <span class="item-note">(${s(item.notes)})</span>` : ''}</td>
          <td class="price-col"><span class="${item.source === 'set_menu' ? 'incl-badge' : 'extra-badge'}" style="${item.source === 'set_menu' ? 'background:#dbeafe;color:#1e40af;border-color:#93c5fd;' : ''}">${item.source === 'set_menu' ? 'SET' : 'EXTRA'}</span></td>
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

  const logoDataUrl = getLogoAsDataUrl(data.branchLogoUrl);

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
    Generated ${new Date().toLocaleDateString()} &bull; Banquet Event Order
  </div>
</body>
</html>`;

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
