import { build as esbuild } from "esbuild";
import { rm, readFile } from "fs/promises";
import { buildQaSourceIndex } from "./build-qa-source-index";

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  const workerOnly = process.argv.includes("--qa-worker-only");
  if (!workerOnly) {
  console.log("building client...");
  const { build: viteBuild } = await import("vite");
  await viteBuild();
  }

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  if (!workerOnly) await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: allDeps,
    logLevel: "info",
  });
  await esbuild({
    entryPoints: ["server/qa/worker-entry.ts"], platform: "node", bundle: true,
    format: "cjs", outfile: "dist/qa-worker.cjs", minify: true, external: allDeps,
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "info",
  });
  await buildQaSourceIndex();
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
