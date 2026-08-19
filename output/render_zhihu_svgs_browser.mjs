import puppeteer from "/home/chenzute/.npm/_npx/bb964472b4759b27/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/home/chenzute/.cache/puppeteer/chrome/linux-152.0.7977.42/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 3200, height: 2400, deviceScaleFactor: 1 });
for (const file of ["codex-adapter-full-chain.svg", "skill-tool-mcp.svg", "zhihu-context-memory.svg", "zhihu-tool-roundtrip.svg", "zhihu-self-evolution-ledger.svg"]) {
  const svg = await readFile(resolve(file), "utf8");
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const element = await page.$("svg");
  const box = await element.boundingBox();
  await page.screenshot({ path: file.replace(/\.svg$/, ".png"), omitBackground: true, clip: box });
  console.log(file, box);
}
await browser.close();
