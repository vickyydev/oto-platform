import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSourceIndex } from "../server/qa/source-index";

export async function buildQaSourceIndex(): Promise<void> {
  const sha = process.env.RENDER_GIT_COMMIT || process.env.QA_SOURCE_VERSION || process.env.GITHUB_SHA || "unversioned";
  const index = await buildSourceIndex(resolve(process.cwd()), sha);
  await mkdir("dist", { recursive: true });
  await writeFile("dist/qa-source-index.json", JSON.stringify(index));
  console.log(`QA source index: ${index.files} approved files`);
}
