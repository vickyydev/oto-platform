import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Three Replit plugins used to sit here: a runtime error overlay, the
// cartographer and a dev banner, the last two switched on by REPL_ID being
// defined. They are Replit workspace tooling — an overlay drawn by Replit's
// own iframe, a map of the project for Replit's editor — and off Replit they
// are dependencies that do nothing. The REPL_ID test went with them: nothing
// here now behaves differently because of a variable somebody else's host
// happens to set.

export default defineConfig({
        plugins: [react()],
        resolve: {
                alias: {
                        "@": path.resolve(import.meta.dirname, "client", "src"),
                        "@shared": path.resolve(import.meta.dirname, "shared"),
                        // The export's 619 MB of attached_assets did not come across
                        // (see README.md); nothing imports through this alias, and it
                        // stays so an import that appears later fails at the build
                        // rather than resolving to something unexpected.
                        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
                },
        },
        root: path.resolve(import.meta.dirname, "client"),
        build: {
                outDir: path.resolve(import.meta.dirname, "dist/public"),
                emptyOutDir: true,
                // Source maps are built but NOT served: they are the whole client
                // source, and on the old stack they were public (intake note 01,
                // finding 11). The Dockerfile copies dist/ wholesale, so this is a
                // known residue rather than a fixed problem — the fix belongs with
                // the static-serving change in S2-17b.
                sourcemap: true,
        },
        server: {
                fs: {
                        strict: true,
                        deny: ["**/.*"],
                },
        },
});
