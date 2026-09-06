import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Verification gates turn "the model says done" into "the system verified
 * done". A gate is a plain command executed in the workspace (through the
 * same policy gate and process manager as any tool shell command) whose exit
 * code decides pass/fail; its bounded output tail becomes evidence.
 */

export interface VerificationGate {
  name: string;
  command: string;
  kind: "test" | "typecheck" | "lint" | "build" | "custom";
}

export interface VerificationGateResult {
  name: string;
  command: string;
  kind: VerificationGate["kind"];
  exitCode?: number;
  signal?: string;
  passed: boolean;
  outputTail: string;
  durationMs: number;
}

export interface VerificationResult {
  passed: boolean;
  gates: VerificationGateResult[];
}

interface DetectedManifest {
  file: string;
  gates: VerificationGate[];
}

const NPM_GATE_ORDER: Array<[string, VerificationGate["kind"], string]> = [
  ["test", "test", "test"],
  ["typecheck", "typecheck", "typecheck"],
  ["lint", "lint", "lint"],
  ["build", "build", "build"],
];

/**
 * Detect a sensible default verification spec from project manifests.
 * Deterministic and local: no network, no model involvement.
 */
export function detectVerificationGates(root: string): VerificationGate[] {
  const gates: VerificationGate[] = [];

  const packageJsonPath = join(root, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      const scripts = pkg.scripts ?? {};
      const runner = npmRunnerFor(pkg.packageManager);
      for (const [script, kind, label] of NPM_GATE_ORDER) {
        if (typeof scripts[script] === "string") {
          gates.push({ name: label, command: `${runner} run ${script}`, kind });
        }
      }
      return gates;
    } catch {
      // Malformed manifest: fall through to other detectors.
    }
  }

  const detected: DetectedManifest[] = [
    {
      file: join(root, "Cargo.toml"),
      gates: [
        { name: "typecheck", command: "cargo check", kind: "typecheck" },
        { name: "test", command: "cargo test", kind: "test" },
      ],
    },
    {
      file: join(root, "go.mod"),
      gates: [
        { name: "test", command: "go test ./...", kind: "test" },
        { name: "build", command: "go build ./...", kind: "build" },
      ],
    },
    {
      file: join(root, "pyproject.toml"),
      gates: [{ name: "test", command: "python -m pytest", kind: "test" }],
    },
    {
      file: join(root, "Makefile"),
      gates: [{ name: "test", command: "make test", kind: "test" }],
    },
  ];
  for (const candidate of detected) {
    if (existsSync(candidate.file)) gates.push(...candidate.gates);
  }
  return gates;
}

function npmRunnerFor(packageManager: string | undefined): string {
  const manager = packageManager?.split("@")[0]?.trim();
  if (manager === "pnpm" || manager === "yarn" || manager === "bun") return manager;
  return "npm";
}

const MAX_GATE_OUTPUT_CHARS = 4_000;

export function tailOutput(output: string): string {
  const normalized = output.trim();
  if (normalized.length <= MAX_GATE_OUTPUT_CHARS) return normalized;
  return `…${normalized.slice(-MAX_GATE_OUTPUT_CHARS)}`;
}
