import { rmSync } from "node:fs";

const target = process.argv[2];

if (!target) {
  console.error("用法: node scripts/clean.mjs <目录路径>");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
