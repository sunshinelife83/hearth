// Copies the no-build dashboard SPA into dist/dashboard for packaging.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "dist/dashboard"), { recursive: true });
cpSync(resolve(root, "src/dashboard"), resolve(root, "dist/dashboard"), { recursive: true });
console.log("dashboard copied to dist/dashboard");
