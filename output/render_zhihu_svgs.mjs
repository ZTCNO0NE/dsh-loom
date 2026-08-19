import sharp from "/chenzute/dsh-src/eval/miniswe-real-agent-loop.B4GBTD/node_modules/.pnpm/sharp@0.35.3_@types+node@22.20.0/node_modules/sharp/dist/index.mjs";

const files = [
  "codex-adapter-full-chain.svg",
  "skill-tool-mcp.svg",
  "zhihu-context-memory.svg",
  "zhihu-tool-roundtrip.svg",
  "zhihu-self-evolution-ledger.svg",
];

for (const file of files) {
  const target = file.replace(/\.svg$/, ".png");
  await sharp(file, { density: 180 }).png().toFile(target);
  console.log(target);
}
