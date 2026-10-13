import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  const indexHtmlPath = path.resolve(distPath, "index.html");

  // fall through to index.html if the file doesn't exist
  app.use("*", (req, res) => {
    const url = req.originalUrl || "";
    const isRedeem = url === "/redeem" || url.startsWith("/redeem?") || url.startsWith("/redeem/");
    if (isRedeem) {
      try {
        let html = fs.readFileSync(indexHtmlPath, "utf-8");
        html = html.replace(
          /<link\s+rel="manifest"[^>]*>/i,
          '<link rel="manifest" href="/redeem.webmanifest?v=1">',
        );
        html = html.replace(
          /<title>[^<]*<\/title>/i,
          "<title>OTO Redeem</title>",
        );
        return res.status(200).set({ "Content-Type": "text/html" }).send(html);
      } catch {
        // fall back to normal index.html
      }
    }
    res.sendFile(indexHtmlPath);
  });
}
