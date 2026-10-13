import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useMutation } from "@tanstack/react-query";
import QRCode from "qrcode";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Download, AlertCircle } from "lucide-react";

type IssueResponse = {
  token: string;
  shortCode: string;
  status: "issued" | "saved" | "redeemed";
  campaign: { id: string; name: string; promoCode: string; description?: string | null };
};

type ErrorResponse = {
  message: string;
  reasonCode?: string;
  campaign?: { id: string; name: string } | null;
};

const OTO_LOGO_URL = "/oto-logo.png";

// ---- Decorative SVG assets (used both in JSX and on canvas) ----

const SVG_BLOB_PINK = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 170'><path d='M0,0 L0,140 C40,170 110,165 150,125 C190,90 215,40 175,8 C155,-8 80,-2 40,12 C22,17 8,8 0,0 Z' fill='#fbb6ce'/></svg>`;

const SVG_BLOB_ORANGE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 170'><path d='M220,0 L220,135 C180,170 95,160 55,115 C12,75 0,30 40,5 C58,-5 130,-2 170,12 C188,18 210,12 220,0 Z' fill='#fdba74'/></svg>`;

const SVG_BLOB_YELLOW = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 170'><path d='M0,170 L0,40 C20,5 80,-5 130,15 C175,35 210,80 185,130 C170,160 130,175 80,170 C50,168 20,172 0,170 Z' fill='#fde68a'/></svg>`;

const SVG_BLOB_BLUE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 170'><path d='M220,170 L220,30 C200,0 130,-10 80,15 C30,40 -5,90 20,140 C40,170 90,175 140,170 C170,168 200,172 220,170 Z' fill='#bfdbfe'/></svg>`;

const SVG_STAR_FACE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 110 110'><path d='M55,6 L67,40 L102,42 L74,64 L84,98 L55,78 L26,98 L36,64 L8,42 L43,40 Z' fill='#fcd34d' stroke='#0f172a' stroke-width='3.5' stroke-linejoin='round'/><circle cx='44' cy='52' r='3.5' fill='#0f172a'/><circle cx='66' cy='52' r='3.5' fill='#0f172a'/><circle cx='35' cy='62' r='3.5' fill='#fb7185' opacity='0.7'/><circle cx='75' cy='62' r='3.5' fill='#fb7185' opacity='0.7'/><path d='M46,68 Q55,76 64,68' stroke='#0f172a' stroke-width='3' fill='none' stroke-linecap='round'/></svg>`;

const SVG_SMILEY_PINK = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 110 110'><circle cx='55' cy='55' r='46' fill='#f9a8d4' stroke='#0f172a' stroke-width='4'/><circle cx='42' cy='52' r='3.5' fill='#0f172a'/><circle cx='68' cy='52' r='3.5' fill='#0f172a'/><circle cx='34' cy='64' r='4' fill='#fb7185' opacity='0.55'/><circle cx='76' cy='64' r='4' fill='#fb7185' opacity='0.55'/><path d='M40,68 Q55,82 70,68' stroke='#0f172a' stroke-width='3.5' fill='none' stroke-linecap='round'/></svg>`;

const SVG_BEAR = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 170'><g><ellipse cx='130' cy='22' rx='22' ry='17' fill='#ffffff' stroke='#0f172a' stroke-width='2.5'/><rect x='121' y='13' width='18' height='16' fill='#fbcfe8' stroke='#0f172a' stroke-width='2' rx='2'/><path d='M130,7 v6 M125,15 h10' stroke='#0f172a' stroke-width='2' stroke-linecap='round'/><rect x='119' y='20' width='22' height='3' fill='#f472b6'/><path d='M118,34 l-7,5 l5,-9 z' fill='#ffffff' stroke='#0f172a' stroke-width='2'/></g><ellipse cx='65' cy='128' rx='52' ry='38' fill='#86efac' stroke='#0f172a' stroke-width='4'/><ellipse cx='65' cy='130' rx='28' ry='22' fill='#bbf7d0'/><circle cx='65' cy='75' r='38' fill='#86efac' stroke='#0f172a' stroke-width='4'/><circle cx='34' cy='52' r='12' fill='#86efac' stroke='#0f172a' stroke-width='4'/><circle cx='96' cy='52' r='12' fill='#86efac' stroke='#0f172a' stroke-width='4'/><circle cx='34' cy='52' r='5.5' fill='#fda4af'/><circle cx='96' cy='52' r='5.5' fill='#fda4af'/><circle cx='51' cy='72' r='4' fill='#0f172a'/><circle cx='79' cy='72' r='4' fill='#0f172a'/><ellipse cx='65' cy='84' rx='4' ry='2.8' fill='#0f172a'/><path d='M58,90 Q65,96 72,90' stroke='#0f172a' stroke-width='2.5' fill='none' stroke-linecap='round'/><circle cx='42' cy='86' r='4' fill='#fda4af' opacity='0.7'/><circle cx='88' cy='86' r='4' fill='#fda4af' opacity='0.7'/><ellipse cx='22' cy='118' rx='13' ry='19' fill='#86efac' stroke='#0f172a' stroke-width='4' transform='rotate(-22 22 118)'/><ellipse cx='108' cy='118' rx='13' ry='19' fill='#86efac' stroke='#0f172a' stroke-width='4' transform='rotate(22 108 118)'/><ellipse cx='40' cy='162' rx='16' ry='8' fill='#86efac' stroke='#0f172a' stroke-width='4'/><ellipse cx='90' cy='162' rx='16' ry='8' fill='#86efac' stroke='#0f172a' stroke-width='4'/></svg>`;

function splitTitle(name: string): { main: string; bubble: string | null } {
  const m = name.match(/^(.*?)\s*(\([^)]+\))\s*$/);
  if (m && m[1].trim()) return { main: m[1].trim(), bubble: m[2] };
  return { main: name, bubble: null };
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawStarSolid(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fill: string,
) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.45;
    const x = cx + Math.cos(angle) * rad;
    const y = cy + Math.sin(angle) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawCornerBracket(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  thickness: number,
  color: string,
  flipX: boolean,
  flipY: boolean,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, 0);
  ctx.lineTo(size, thickness);
  ctx.lineTo(thickness, thickness);
  ctx.lineTo(thickness, size);
  ctx.lineTo(0, size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

async function buildCompositeImage(
  promoCode: string,
  campaignName: string,
  shortCode: string,
  description?: string | null,
): Promise<{ blob: Blob; dataUrl: string }> {
  const [
    qrImg,
    blobPink,
    blobOrange,
    blobYellow,
    blobBlue,
    starImg,
    smileyImg,
    bearImg,
    logoImg,
  ] = await Promise.all([
    QRCode.toDataURL(promoCode, {
      width: 720,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" },
    }).then(loadImage),
    svgToImage(SVG_BLOB_PINK),
    svgToImage(SVG_BLOB_ORANGE),
    svgToImage(SVG_BLOB_YELLOW),
    svgToImage(SVG_BLOB_BLUE),
    svgToImage(SVG_STAR_FACE),
    svgToImage(SVG_SMILEY_PINK),
    svgToImage(SVG_BEAR),
    loadImage(OTO_LOGO_URL).catch(() => null as unknown as HTMLImageElement),
  ]);

  const W = 800;
  const guestText = (description && description.trim()) ? description.trim() : campaignName;
  const { main: titleMain, bubble: titleBubble } = splitTitle(guestText);

  // Measurement pass
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d")!;
  mctx.font = "900 52px system-ui, -apple-system, sans-serif";
  const titleLines = wrapText(mctx, titleMain, W - 64 - 60);
  const descLines: string[] = [];

  const headerH = 140;
  const cardY = headerH + 24;
  const cardPadTop = 56;
  let yCursor = cardY + cardPadTop;
  // VOUCHER pill height
  yCursor += 44 + 28;
  // title
  yCursor += titleLines.length * 56;
  if (titleBubble) yCursor += 14 + 64;
  // description
  if (descLines.length) {
    yCursor += 24 + (descLines.length * 30 + 36);
  }
  // QR panel
  const qrSize = 460;
  const qrPad = 26;
  yCursor += 24 + qrSize + qrPad * 2;
  // redemption code label + chip
  yCursor += 26 + 18 + 88;
  // bottom pill
  yCursor += 28 + 44;
  // bottom padding
  yCursor += 32;
  const cardH = yCursor - cardY;
  const H = cardY + cardH + 40;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Page background — soft cream
  ctx.fillStyle = "#fff5e4";
  ctx.fillRect(0, 0, W, H);

  // Corner blobs
  ctx.drawImage(blobPink, -20, -10, 240, 180);
  ctx.drawImage(blobOrange, W - 220, -10, 240, 180);
  ctx.drawImage(blobYellow, -20, H - 200, 220, 200);
  ctx.drawImage(blobBlue, W - 220, H - 200, 240, 200);

  // Confetti / sparkles around the page
  const dots: Array<[number, number, string, number]> = [
    [80, 70, "#fbbf24", 6],
    [W - 80, 90, "#f9a8d4", 6],
    [40, 250, "#60a5fa", 5],
    [W - 40, 240, "#34d399", 6],
    [60, H - 380, "#f472b6", 5],
    [W - 50, H - 360, "#fbbf24", 6],
    [30, H - 80, "#a78bfa", 5],
    [W - 30, H - 70, "#34d399", 6],
  ];
  for (const [x, y, c, r] of dots) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // small sparkles
  ctx.fillStyle = "#0f172a";
  ctx.font = "900 22px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("✦", 50, 180);
  ctx.fillText("✦", W - 60, 200);
  ctx.fillText("✦", 30, H / 2);
  ctx.fillStyle = "#fb923c";
  ctx.fillText("?", W - 30, H / 2 - 40);
  ctx.fillStyle = "#a78bfa";
  ctx.fillText("?", 40, H / 2 + 80);

  // Header: OTO logo + tagline
  if (logoImg) {
    const lh = 76;
    const lw = (logoImg.width / logoImg.height) * lh;
    ctx.drawImage(logoImg, (W - lw) / 2, 30, lw, lh);
  }
  ctx.fillStyle = "#0f172a";
  ctx.font = "700 14px system-ui, -apple-system, sans-serif";
  ctx.fillText("Central Floresta, Floor B", W / 2, 124);

  // Main card
  const cardX = 32;
  const cardW = W - 64;
  ctx.fillStyle = "#0f172a";
  roundRectPath(ctx, cardX + 8, cardY + 8, cardW, cardH, 36);
  ctx.fill();
  ctx.fillStyle = "#fffaf0";
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 36);
  ctx.fill();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 4;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 36);
  ctx.stroke();

  // Inner dashed-ish offset frame (subtle)
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 2;
  roundRectPath(ctx, cardX + 14, cardY + 14, cardW - 28, cardH - 28, 28);
  ctx.stroke();

  // VOUCHER pill (with stars)
  let y = cardY + cardPadTop;
  ctx.font = "900 20px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  const pillLabel = "VOUCHER";
  const pillTextW = ctx.measureText(pillLabel).width;
  const pillW = pillTextW + 110;
  const pillH = 44;
  const pillX = (W - pillW) / 2;
  ctx.fillStyle = "#0f172a";
  roundRectPath(ctx, pillX + 5, y + 5, pillW, pillH, 22);
  ctx.fill();
  ctx.fillStyle = "#fcd34d";
  roundRectPath(ctx, pillX, y, pillW, pillH, 22);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0f172a";
  roundRectPath(ctx, pillX, y, pillW, pillH, 22);
  ctx.stroke();
  drawStarSolid(ctx, pillX + 24, y + pillH / 2, 8, "#0f172a");
  drawStarSolid(ctx, pillX + pillW - 24, y + pillH / 2, 8, "#0f172a");
  ctx.fillStyle = "#0f172a";
  ctx.fillText(pillLabel, W / 2, y + 30);
  y += pillH + 28;

  // Title (sticker style: white outline + dark fill)
  ctx.font = "900 52px system-ui, -apple-system, sans-serif";
  ctx.lineJoin = "round";
  for (const line of titleLines) {
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(line, W / 2, y + 44);
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#0f172a";
    // outer dark outline (drawn over the white to give sticker edge)
    ctx.globalCompositeOperation = "destination-over";
    ctx.strokeText(line, W / 2, y + 44);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0f172a";
    ctx.fillText(line, W / 2, y + 44);
    y += 56;
  }

  if (titleBubble) {
    y += 14;
    ctx.font = "900 44px system-ui, -apple-system, sans-serif";
    const tbW = ctx.measureText(titleBubble).width + 60;
    const tbH = 64;
    const tbX = (W - tbW) / 2;
    ctx.fillStyle = "#0f172a";
    roundRectPath(ctx, tbX + 5, y + 5, tbW, tbH, 22);
    ctx.fill();
    ctx.fillStyle = "#fbcfe8";
    roundRectPath(ctx, tbX, y, tbW, tbH, 22);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0f172a";
    roundRectPath(ctx, tbX, y, tbW, tbH, 22);
    ctx.stroke();
    ctx.fillStyle = "#db2777";
    ctx.fillText(titleBubble, W / 2, y + 48);
    y += tbH;
  }

  // Description bubble (mint) with green check badge
  if (descLines.length) {
    y += 24;
    ctx.font = "600 22px system-ui, -apple-system, sans-serif";
    const lineH = 30;
    const blockH = descLines.length * lineH + 36;
    const blockX = cardX + 36;
    const blockW = cardW - 72;
    const blockY = y;
    ctx.fillStyle = "#0f172a";
    roundRectPath(ctx, blockX + 6, blockY + 6, blockW, blockH, 22);
    ctx.fill();
    ctx.fillStyle = "#bbf7d0";
    roundRectPath(ctx, blockX, blockY, blockW, blockH, 22);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0f172a";
    roundRectPath(ctx, blockX, blockY, blockW, blockH, 22);
    ctx.stroke();
    ctx.fillStyle = "#064e3b";
    let ty = blockY + 32;
    for (const line of descLines) {
      ctx.fillText(line, W / 2, ty);
      ty += lineH;
    }
    // green check badge centered on top edge
    const badgeR = 18;
    const badgeCX = W / 2;
    const badgeCY = blockY;
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(badgeCX + 2, badgeCY + 2, badgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(badgeCX, badgeCY, badgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0f172a";
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(badgeCX - 7, badgeCY);
    ctx.lineTo(badgeCX - 2, badgeCY + 6);
    ctx.lineTo(badgeCX + 8, badgeCY - 5);
    ctx.stroke();
    ctx.lineCap = "butt";
    y = blockY + blockH;
  }

  // QR panel with yellow L brackets
  y += 24;
  const panelW = qrSize + qrPad * 2;
  const panelH = qrSize + qrPad * 2;
  const panelX = (W - panelW) / 2;
  const panelY = y;
  ctx.fillStyle = "#0f172a";
  roundRectPath(ctx, panelX + 6, panelY + 6, panelW, panelH, 26);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 26);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#0f172a";
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 26);
  ctx.stroke();
  ctx.drawImage(qrImg, panelX + qrPad, panelY + qrPad, qrSize, qrSize);
  // yellow L brackets (inside the panel near corners)
  const brSize = 56;
  const brTh = 12;
  const brColor = "#facc15";
  const brInset = 14;
  drawCornerBracket(ctx, panelX + brInset, panelY + brInset, brSize, brTh, brColor, false, false);
  drawCornerBracket(ctx, panelX + panelW - brInset, panelY + brInset, brSize, brTh, brColor, true, false);
  drawCornerBracket(ctx, panelX + brInset, panelY + panelH - brInset, brSize, brTh, brColor, false, true);
  drawCornerBracket(ctx, panelX + panelW - brInset, panelY + panelH - brInset, brSize, brTh, brColor, true, true);
  y = panelY + panelH;

  // REDEMPTION CODE label with brackets
  y += 26;
  ctx.font = "900 18px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = "#0f172a";
  const labelText = "REDEMPTION CODE";
  const labelW = ctx.measureText(labelText).width;
  ctx.fillText(labelText, W / 2, y);
  // decorative brackets ‹ ›
  ctx.font = "900 22px system-ui, -apple-system, sans-serif";
  ctx.fillText("‹", W / 2 - labelW / 2 - 18, y + 1);
  ctx.fillText("›", W / 2 + labelW / 2 + 18, y + 1);

  // Code chip (yellow, wide letterspacing)
  y += 18;
  const codeChars = shortCode.toUpperCase().split("").join("  ");
  ctx.font = "900 60px ui-monospace, SFMono-Regular, Menlo, monospace";
  const codeW = Math.max(ctx.measureText(codeChars).width + 80, 280);
  const codeH = 88;
  const codeX = (W - codeW) / 2;
  const codeY = y;
  ctx.fillStyle = "#0f172a";
  roundRectPath(ctx, codeX + 6, codeY + 6, codeW, codeH, 22);
  ctx.fill();
  ctx.fillStyle = "#fde047";
  roundRectPath(ctx, codeX, codeY, codeW, codeH, 22);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#0f172a";
  roundRectPath(ctx, codeX, codeY, codeW, codeH, 22);
  ctx.stroke();
  ctx.fillStyle = "#0f172a";
  ctx.fillText(codeChars, W / 2, codeY + 64);
  y = codeY + codeH;

  // Bottom "Show this at reception" pill (white, with stars)
  y += 28;
  ctx.font = "800 16px system-ui, -apple-system, sans-serif";
  const footerLabel = "Show this at reception";
  const footerW = ctx.measureText(footerLabel).width + 110;
  const footerH = 44;
  const footerX = (W - footerW) / 2;
  ctx.fillStyle = "#0f172a";
  roundRectPath(ctx, footerX + 4, y + 4, footerW, footerH, 22);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  roundRectPath(ctx, footerX, y, footerW, footerH, 22);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0f172a";
  roundRectPath(ctx, footerX, y, footerW, footerH, 22);
  ctx.stroke();
  drawStarSolid(ctx, footerX + 24, y + footerH / 2, 8, "#fbbf24");
  drawStarSolid(ctx, footerX + footerW - 24, y + footerH / 2, 8, "#fbbf24");
  ctx.fillStyle = "#0f172a";
  ctx.fillText(footerLabel, W / 2, y + 28);

  // Decorative mascot + smiley at the bottom corners (overlap card edge)
  ctx.drawImage(bearImg, W - 170, H - 200, 150, 160);
  ctx.drawImage(smileyImg, 10, H - 130, 110, 110);
  ctx.drawImage(starImg, 12, 200, 86, 86);
  ctx.drawImage(starImg, W - 100, H - 360, 78, 78);

  ctx.textAlign = "center";

  const dataUrl = canvas.toDataURL("image/png");
  const blob: Blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/png"),
  );
  return { blob, dataUrl };
}

// ---- Reusable JSX helpers ----

function SvgInline({
  svg,
  className,
  style,
  testId,
}: {
  svg: string;
  className?: string;
  style?: React.CSSProperties;
  testId?: string;
}) {
  return (
    <div
      aria-hidden
      className={className}
      style={style}
      data-testid={testId}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d="M12,2 L14.6,9.5 L22,10 L16.2,14.8 L18.2,22 L12,17.8 L5.8,22 L7.8,14.8 L2,10 L9.4,9.5 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CornerBrackets() {
  const cls =
    "absolute h-7 w-7 border-yellow-400";
  return (
    <>
      <span className={`${cls} top-2 left-2 border-t-[6px] border-l-[6px] rounded-tl-md`} />
      <span className={`${cls} top-2 right-2 border-t-[6px] border-r-[6px] rounded-tr-md`} />
      <span className={`${cls} bottom-2 left-2 border-b-[6px] border-l-[6px] rounded-bl-md`} />
      <span className={`${cls} bottom-2 right-2 border-b-[6px] border-r-[6px] rounded-br-md`} />
    </>
  );
}

export default function QrLandingPage() {
  const [, params] = useRoute("/c/:id");
  const campaignId = params?.id ?? "";

  const [imgDataUrl, setImgDataUrl] = useState<string | null>(null);
  const [imgBlob, setImgBlob] = useState<Blob | null>(null);
  const [qrOnlyDataUrl, setQrOnlyDataUrl] = useState<string | null>(null);
  const [data, setData] = useState<IssueResponse | null>(null);
  const [errorState, setErrorState] = useState<ErrorResponse | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const issueMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/public/campaigns/${campaignId}/qr`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json();
      if (!res.ok) throw json as ErrorResponse;
      return json as IssueResponse;
    },
    onSuccess: async (d) => {
      setData(d);
      setErrorState(null);
      const [{ blob, dataUrl }, qrOnly] = await Promise.all([
        buildCompositeImage(
          d.campaign.promoCode,
          d.campaign.name,
          d.shortCode,
          d.campaign.description,
        ),
        QRCode.toDataURL(d.campaign.promoCode, {
          width: 720,
          margin: 1,
          errorCorrectionLevel: "M",
          color: { dark: "#0f172a", light: "#ffffff" },
        }),
      ]);
      setImgDataUrl(dataUrl);
      setImgBlob(blob);
      setQrOnlyDataUrl(qrOnly);
    },
    onError: (err: ErrorResponse) => setErrorState(err),
  });

  useEffect(() => {
    if (!campaignId || fetchedRef.current) return;
    fetchedRef.current = true;
    issueMutation.mutate();
  }, [campaignId]);

  const onSave = async () => {
    if (!imgBlob || !imgDataUrl || !data) return;
    setSaveHint(null);

    const filename = `promo-${data.shortCode}.png`;
    const file = new File([imgBlob], filename, { type: "image/png" });

    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void>;
    };

    let shared = false;
    if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
      try {
        await nav.share({
          files: [file],
          title: data.campaign.name,
          text: "Save this image to your Photos to redeem at reception.",
        });
        shared = true;
      } catch (e: any) {
        if (e?.name === "AbortError") {
          shared = true;
        }
      }
    }

    if (!shared) {
      const a = document.createElement("a");
      a.href = imgDataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setSaveHint(
        "If the image opened in a new tab, long-press it and choose \u201cSave to Photos\u201d.",
      );
    }

    try {
      await apiRequest("POST", `/api/public/qr/${data.token}/saved`);
    } catch {}
  };

  const guestText = data ? (data.campaign.description?.trim() || data.campaign.name) : "";
  const titleParts = data ? splitTitle(guestText) : { main: "", bubble: null };

  return (
    <div
      className="min-h-screen flex flex-col relative overflow-hidden"
      style={{ background: "#fff5e4" }}
    >
      {/* Corner blobs */}
      <SvgInline
        svg={SVG_BLOB_PINK}
        className="pointer-events-none absolute -top-4 -left-6 w-[44%] max-w-[260px]"
      />
      <SvgInline
        svg={SVG_BLOB_ORANGE}
        className="pointer-events-none absolute -top-4 -right-6 w-[44%] max-w-[260px]"
      />
      <SvgInline
        svg={SVG_BLOB_YELLOW}
        className="pointer-events-none absolute -bottom-6 -left-6 w-[42%] max-w-[240px]"
      />
      <SvgInline
        svg={SVG_BLOB_BLUE}
        className="pointer-events-none absolute -bottom-6 -right-6 w-[44%] max-w-[260px]"
      />

      {/* Floating decorative confetti */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <span className="absolute top-24 left-6 h-2.5 w-2.5 rounded-full bg-amber-300" />
        <span className="absolute top-32 right-10 h-2 w-2 rounded-full bg-emerald-400" />
        <span className="absolute top-[42%] left-2 h-2 w-2 rounded-full bg-pink-400" />
        <span className="absolute top-[55%] right-3 h-2.5 w-2.5 rounded-full bg-sky-400" />
        <span className="absolute bottom-32 left-3 h-2 w-2 rounded-full bg-violet-400" />
        <span className="absolute bottom-40 right-4 h-2.5 w-2.5 rounded-full bg-amber-300" />
        <span className="absolute top-[20%] right-6 text-pink-400 font-black text-xl select-none">?</span>
        <span className="absolute top-[60%] left-4 text-orange-400 font-black text-xl select-none">?</span>
        <span className="absolute top-[35%] right-4 text-slate-900 text-base select-none">✦</span>
        <span className="absolute top-[70%] left-6 text-slate-900 text-base select-none">✦</span>
      </div>

      <main className="flex-1 px-4 pt-6 pb-10 flex flex-col items-center relative z-10">
        {/* Header */}
        <div className="flex flex-col items-center gap-1 mb-4">
          <img
            src={OTO_LOGO_URL}
            alt="OTO"
            className="h-14 w-auto"
            data-testid="img-oto-logo"
          />
          <p className="text-[11px] font-bold tracking-[0.35em] text-slate-700">
            Central Floresta, Floor B
          </p>
        </div>

        <div className="max-w-sm w-full relative">
          {/* Decorative mascot/star peeking around the card */}
          <SvgInline
            svg={SVG_STAR_FACE}
            className="pointer-events-none absolute -left-6 top-28 w-12 sm:w-14 z-20"
          />
          <SvgInline
            svg={SVG_BEAR}
            className="pointer-events-none absolute -right-2 -bottom-4 w-24 z-20"
          />
          <SvgInline
            svg={SVG_SMILEY_PINK}
            className="pointer-events-none absolute -left-4 -bottom-2 w-16 z-20"
          />

          {issueMutation.isPending && (
            <div
              className="bg-white border-[3px] border-slate-900 rounded-3xl shadow-[6px_6px_0_0_rgba(15,23,42,1)] px-6 py-10 flex flex-col items-center gap-4 text-slate-700"
              data-testid="status-loading"
            >
              <Loader2 className="h-10 w-10 animate-spin text-pink-500" />
              <p className="font-bold text-lg">Cooking up your voucher…</p>
              <p className="text-sm text-slate-500 text-center">Hang tight, almost ready!</p>
            </div>
          )}

          {errorState && (
            <div
              className="bg-white border-[3px] border-slate-900 rounded-3xl shadow-[6px_6px_0_0_rgba(15,23,42,1)] p-6 text-center"
              data-testid="status-error"
            >
              <div className="mx-auto mb-4 inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-amber-200 border-[3px] border-slate-900">
                <AlertCircle className="h-7 w-7 text-slate-900" />
              </div>
              <h2 className="text-xl font-extrabold mb-1 text-slate-900" data-testid="text-error-title">
                {errorState.campaign?.name ?? "Promo unavailable"}
              </h2>
              <p className="text-slate-600" data-testid="text-error-message">{errorState.message}</p>
            </div>
          )}

          {data && imgDataUrl && (
            <div
              className="relative bg-[#fffaf0] border-[3px] border-slate-900 rounded-[28px] shadow-[8px_8px_0_0_rgba(15,23,42,1)] px-5 pt-10 pb-6 flex flex-col items-center gap-5"
              data-testid="card-qr"
            >
              {/* Inner subtle frame */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-2 rounded-[22px] border border-slate-900/70"
              />

              {/* VOUCHER pill with stars */}
              <div
                className="-mt-[34px] inline-flex items-center gap-2 px-5 py-2 rounded-full bg-yellow-300 border-[3px] border-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,1)] relative z-10"
                data-testid="badge-voucher"
              >
                <StarIcon className="h-3.5 w-3.5 text-slate-900" />
                <span className="text-xs font-black tracking-[0.25em] text-slate-900">VOUCHER</span>
                <StarIcon className="h-3.5 w-3.5 text-slate-900" />
              </div>

              {/* Title — sticker style with optional pink-bubble suffix */}
              <div className="relative z-10 text-center" data-testid="text-campaign-name">
                <h1
                  className="text-[34px] leading-[1.05] font-black text-slate-900 tracking-tight"
                  style={{
                    textShadow:
                      "3px 0 0 #fff, -3px 0 0 #fff, 0 3px 0 #fff, 0 -3px 0 #fff, 2px 2px 0 #fff, -2px -2px 0 #fff, 2px -2px 0 #fff, -2px 2px 0 #fff, 4px 4px 0 #0f172a",
                  }}
                >
                  {titleParts.main}
                </h1>
                {titleParts.bubble && (
                  <div className="mt-3 flex justify-center">
                    <span
                      className="inline-block px-5 py-1 rounded-2xl bg-pink-200 border-[3px] border-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,1)] text-[28px] font-black text-pink-600 leading-tight"
                      data-testid="text-campaign-name-bubble"
                    >
                      {titleParts.bubble}
                    </span>
                  </div>
                )}
              </div>

              {/* QR panel with yellow corner brackets */}
              {qrOnlyDataUrl && (
                <div className="relative w-full rounded-2xl bg-white border-[3px] border-slate-900 shadow-[4px_4px_0_0_rgba(15,23,42,1)] p-4 z-10">
                  <CornerBrackets />
                  <img
                    src={qrOnlyDataUrl}
                    alt="Promo QR"
                    className="w-full rounded-lg"
                    data-testid="img-qr"
                  />
                </div>
              )}

              {/* Redemption code label with brackets */}
              <div className="w-full text-center z-10">
                <div className="inline-flex items-center gap-2 mb-2">
                  <span className="text-slate-900 font-black text-base">‹</span>
                  <p className="text-xs font-black uppercase tracking-[0.25em] text-slate-700">
                    Redemption Code
                  </p>
                  <span className="text-slate-900 font-black text-base">›</span>
                </div>
                <div className="inline-flex items-center justify-center min-w-[14rem] px-6 py-3 rounded-2xl bg-yellow-300 border-[3px] border-slate-900 shadow-[5px_5px_0_0_rgba(15,23,42,1)]">
                  <span
                    className="text-3xl font-black font-mono tracking-[0.4em] text-slate-900"
                    data-testid="text-short-code"
                  >
                    {data.shortCode.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Save button — pink chunky */}
              <button
                onClick={onSave}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-pink-400 hover:bg-pink-500 active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_0_rgba(15,23,42,1)] transition-all border-[3px] border-slate-900 shadow-[5px_5px_0_0_rgba(15,23,42,1)] px-6 py-4 text-base font-black text-white uppercase tracking-wider z-10"
                data-testid="button-save-qr"
              >
                <Download className="h-5 w-5" /> Save to Photos
              </button>

              {/* Footer pill with stars */}
              <div
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white border-[3px] border-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,1)] z-10"
                data-testid="pill-show-at-reception"
              >
                <StarIcon className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-xs font-black tracking-wide text-slate-900">
                  Show this at reception
                </span>
                <StarIcon className="h-3.5 w-3.5 text-amber-400" />
              </div>

              {saveHint && (
                <p className="text-xs text-slate-500 text-center z-10" data-testid="text-save-hint">
                  {saveHint}
                </p>
              )}
              {data.status === "saved" && (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-200 border-2 border-slate-900 text-xs font-bold text-emerald-900 z-10"
                  data-testid="status-saved"
                >
                  ✓ Saved to your phone
                </div>
              )}
              {data.status === "redeemed" && (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-200 border-2 border-slate-900 text-xs font-bold text-sky-900 z-10"
                  data-testid="status-redeemed"
                >
                  Already redeemed
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      <footer className="text-center text-xs font-semibold text-slate-500 py-4 relative z-10">
        One QR per device per campaign · OTO Play Park
      </footer>
    </div>
  );
}
