import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["demo", "savanna", "module"];
const htmlFiles = [];

async function collect(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.html?$/i.test(entry.name)) htmlFiles.push(path);
  }
}

for (const root of roots) await collect(root);
const failures = [];
for (const file of htmlFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/<(audio|video)\b[\s\S]*?<\/\1>/gi)) {
    const element = match[0];
    if (!/<track\b[^>]*kind=["']captions["']/i.test(element) || !/(transcript|aria-describedby|data-transcript)/i.test(element)) {
      failures.push(`${file}: media needs a captions track and visible transcript reference`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Media caption check passed (${htmlFiles.length} HTML files scanned).`);
}
