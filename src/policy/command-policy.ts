/**
 * Static shell-command risk classifier.
 *
 * This is deliberately a conservative speed bump plus an audit signal, not a
 * security boundary: shell semantics are too rich to classify perfectly, and
 * the real boundaries are workspace confinement, the environment allowlist,
 * and (when enabled) OS sandboxes. Tier meanings:
 *
 *  tier 0 — inspection only, allowed even in readonly mode
 *  tier 1 — ordinary workspace work (build, test, local file edits)
 *  tier 2 — outside-effect or hard-to-undo actions (network fetches,
 *           package installs, recursive deletes, pushes, permissions)
 *  tier 3 — always blocked regardless of mode (privilege escalation,
 *           system management, remote shell piping, profile tampering)
 */

export type CommandTier = 0 | 1 | 2 | 3;

export interface CommandClassification {
  tier: CommandTier;
  /** Rule identifiers that matched; empty means the tier-1 default. */
  rules: string[];
}

interface TierRule {
  id: string;
  pattern: RegExp;
}

const TIER3_RULES: readonly TierRule[] = [
  { id: "privilege-escalation", pattern: /(^|[\s;&|(])(sudo|su|doas|pkexec|runuser)\s/ },
  { id: "system-power", pattern: /(^|[\s;&|(])(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/ },
  { id: "service-manager", pattern: /(^|[\s;&|(])(systemctl|launchctl|service|chkconfig|update-rc\.d)\b/ },
  { id: "scheduler", pattern: /(^|[\s;&|(])crontab\b/ },
  { id: "disk-destructive", pattern: /\b(mkfs(\.\w+)?|fdisk|parted|diskutil)\b/ },
  { id: "disk-dd", pattern: /\bdd\b[^|]*\bof=/ },
  { id: "fork-bomb", pattern: /:\(\)\s*\{\s*:\|:&\s*\};?/ },
  { id: "remote-shell-pipe", pattern: /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/ },
  { id: "remote-shell-pipe-bash", pattern: /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?bash\b/ },
  { id: "remote-exec-args", pattern: /\b(curl|wget)\b[^\n|]*--(exec|install)[-=\s]/ },
  { id: "ssh-remote-exec", pattern: /(^|[\s;&|(])ssh(\.exe)?\s+(?!-)\S/ },
  { id: "shell-profile-write", pattern: /(^|[\s;&|(])(\.bashrc|\.zshrc|\.bash_profile|\.profile|\.zprofile)\b[^&|;]*>>?|(^|[\s;&|(])>>?\s*(\.bashrc|\.zshrc|\.bash_profile|\.profile|\.zprofile)\b/ },
  { id: "chmod-root", pattern: /\bchmod\b[^\n]*\b(777|666)\b[^\n]*\s\/(?!home|Users|tmp)/ },
];

const TIER2_RULES: readonly TierRule[] = [
  { id: "network-fetch", pattern: /(^|[\s;&|(])(curl|wget|fetch|http|nc|ncat|telnet)\b/ },
  { id: "package-install", pattern: /(^|[\s;&|(])(npm|i?pnpm|yarn|bun)\s+(install|i|add|update|upgrade)\b/ },
  { id: "package-install-pip", pattern: /(^|[\s;&|(])(pip3?|uv|poetry)\s+(install|add|update)\b/ },
  { id: "package-install-cargo", pattern: /(^|[\s;&|(])cargo\s+(add|install)\b/ },
  { id: "package-install-gem", pattern: /(^|[\s;&|(])gem\s+install\b/ },
  { id: "system-package", pattern: /(^|[\s;&|(])(apt|apt-get|dnf|yum|pacman|brew|choco|winget)\s+(install|remove|purge|upgrade|update)\b/ },
  { id: "recursive-delete", pattern: /(^|[\s;&|(])rm\b[^\n;&|]*\s-[^\n;&|]*[rR]/ },
  { id: "git-push", pattern: /(^|[\s;&|(])git\s+push\b/ },
  { id: "git-state-mutation", pattern: /(^|[\s;&|(])git\s+(reset\s+--hard|clean\s+-[^\n]*[fdx]|checkout\s+--\s|restore\s+--)/ },
  { id: "npm-publish", pattern: /(^|[\s;&|(])(npm|i?pnpm|yarn|bun)\s+publish\b/ },
  { id: "permission-change", pattern: /(^|[\s;&|(])(chmod|chown|chgrp|icacls|attrib)\b/ },
  { id: "process-kill", pattern: /(^|[\s;&|(])(pkill|killall|kill)\b/ },
  { id: "container-runtime", pattern: /(^|[\s;&|(])(docker|podman|kubectl)\b/ },
  { id: "cloud-cli", pattern: /(^|[\s;&|(])(aws|gcloud|az|gh|glab)\b/ },
  { id: "move-across-dirs", pattern: /(^|[\s;&|(])mv\b[^\n;&|]*\s\/(?!home|Users|tmp)/ },
  { id: "sleep-injection", pattern: /(^|[\s;&|(])sleep\s+\d{3,}\b/ },
];

const TIER0_RULES: readonly TierRule[] = [
  { id: "fs-inspect", pattern: /(^|[\s;&|(])(ls|pwd|cat|head|tail|wc|file|stat|du|df|tree|find|fd|grep|rg|ag|which|where|whereis|whoami|hostname|uname|date|env|printenv|readlink|realpath|basename|dirname|diff|cmp|less|more)\b/ },
  { id: "git-inspect", pattern: /(^|[\s;&|(])git\s+(status|log|show|diff|branch|tag|remote|rev-parse|describe|ls-files|blame|shortlog|reflog|config\s+--(get|list))\b/ },
  { id: "version-check", pattern: /(^|[\s;&|(])\S+\s+(--version|-v|-V|--help|-h)\s*$/ },
  { id: "node-inspect", pattern: /(^|[\s;&|(])node\s+(-e\s+)?["']?(console\.(log|table)|require\(.{0,40}package.json)/ },
];

function firstMatch(rules: readonly TierRule[], command: string): TierRule | undefined {
  return rules.find((rule) => rule.pattern.test(command));
}

/**
 * Classify a shell command. Evaluation order: tier 3 first (block wins),
 * then tier 0 (inspection stays cheap), then tier 2, defaulting to tier 1.
 */
export function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) return { tier: 1, rules: ["empty-command"] };

  const tier3 = firstMatch(TIER3_RULES, trimmed);
  if (tier3) return { tier: 3, rules: [tier3.id] };

  const tier0 = firstMatch(TIER0_RULES, trimmed);
  if (tier0) return { tier: 0, rules: [tier0.id] };

  const tier2 = firstMatch(TIER2_RULES, trimmed);
  if (tier2) return { tier: 2, rules: [tier2.id] };

  return { tier: 1, rules: [] };
}

export type ExecutionMode = "readonly" | "supervised" | "autonomous";

export interface ExecutionDecision {
  decision: "allow" | "needs_user_approval" | "deny";
  reason: string;
  /** True when the caller supplied an explicit user-approval claim. */
  approvalClaimed?: boolean;
}

const READONLY_MESSAGE =
  "The workspace is in readonly mode; this command is not an inspection command. Ask the workspace owner to change execution.mode.";

const TIER2_SUPERVISED_MESSAGE =
  "This command has effects outside the current workspace (tier 2). " +
  "Explain what it does to the user and get their explicit approval in the conversation, " +
  "then retry the exact same command with the input flag approvedByUser set to true.";

const TIER3_MESSAGE =
  "This command is always blocked by DevSpace policy (privilege escalation, system management, " +
  "remote script execution, or shell profile modification). It cannot be approved.";

export function decideExecution(input: {
  mode: ExecutionMode;
  tier: CommandTier;
  approvedByUser?: boolean;
}): ExecutionDecision {
  const { mode, tier, approvedByUser } = input;
  if (tier === 3) {
    return { decision: "deny", reason: TIER3_MESSAGE };
  }
  if (mode === "readonly") {
    return tier === 0
      ? { decision: "allow", reason: "readonly allows tier-0 inspection" }
      : { decision: "deny", reason: READONLY_MESSAGE };
  }
  if (tier <= 1) {
    return { decision: "allow", reason: `tier ${tier} allowed in ${mode} mode` };
  }
  // tier 2 from here on
  if (mode === "autonomous") {
    return { decision: "allow", reason: "tier 2 allowed in autonomous mode" };
  }
  if (approvedByUser === true) {
    return { decision: "allow", reason: "tier 2 allowed by explicit user-approval claim", approvalClaimed: true };
  }
  return { decision: "needs_user_approval", reason: TIER2_SUPERVISED_MESSAGE };
}
