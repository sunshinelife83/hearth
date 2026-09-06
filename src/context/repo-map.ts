import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

/**
 * Context Engine, first slice (P6): a deterministic, local repository map.
 * No embeddings, no network — just the structure a model needs to stop
 * re-walking the tree: languages, manifests, and a bounded directory tree.
 */

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", ".next",
  ".turbo", ".cache", ".venv", "venv", "__pycache__", "target", "coverage",
  ".idea", ".vscode", "vendor",
]);

const MANIFESTS = [
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml",
  "requirements.txt", "Makefile", "composer.json", "Gemfile", "pom.xml",
];

export interface RepoMapOptions {
  maxFiles?: number;
  maxDepth?: number;
}

export interface RepoMap {
  root: string;
  totalFiles: number;
  truncated: boolean;
  totalBytes: number;
  languages: Array<{ extension: string; count: number }>;
  manifests: string[];
  directories: Array<{ path: string; files: number }>;
}

export async function buildRepoMap(root: string, options: RepoMapOptions = {}): Promise<RepoMap> {
  const maxFiles = options.maxFiles ?? 5000;
  const maxDepth = options.maxDepth ?? 20;

  const files: string[] = [];
  const dirFiles = new Map<string, number>();
  const manifests = new Set<string>();
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(path, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(path);
      dirFiles.set(dir, (dirFiles.get(dir) ?? 0) + 1);
      if (MANIFESTS.includes(entry.name)) manifests.add(entry.name);
    }
  };

  await walk(root, 0);

  const byExt = new Map<string, number>();
  let totalBytes = 0;
  for (const file of files) {
    const ext = extname(file).toLowerCase() || "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    try {
      const stats = await stat(file);
      totalBytes += stats.size;
    } catch {
      // File vanished mid-walk; fine for an approximate map.
    }
  }

  const languages = [...byExt.entries()]
    .map(([extension, count]) => ({ extension, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const directories = [...dirFiles.entries()]
    .map(([dir, count]) => ({ path: relative(root, dir) || ".", files: count }))
    .filter((entry) => entry.path !== ".")
    .sort((a, b) => b.files - a.files)
    .slice(0, 25);

  return {
    root,
    totalFiles: files.length,
    truncated,
    totalBytes,
    languages,
    manifests: [...manifests].sort(),
    directories,
  };
}

export function formatRepoMap(map: RepoMap): string {
  const lines = [
    `Repository map for ${map.root}`,
    `Files: ${map.totalFiles}${map.truncated ? "+ (truncated)" : ""}, ~${Math.round(map.totalBytes / 1024)} KB`,
    `Manifests: ${map.manifests.length > 0 ? map.manifests.join(", ") : "none detected"}`,
    "Languages: " + map.languages.map((lang) => `${lang.extension}×${lang.count}`).join(", "),
    "Largest directories:",
    ...map.directories.map((dir) => `  ${dir.path} (${dir.files} files)`),
  ];
  return lines.join("\n");
}

/** Cheap text file reader used by context tools (bounded). */
export async function readTextHead(path: string, maxBytes = 64 * 1024): Promise<string> {
  const content = await readFile(path, "utf8");
  return content.length > maxBytes ? content.slice(0, maxBytes) : content;
}
