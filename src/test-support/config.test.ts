import {
  defaultHearthConfig,
  type HearthConfig,
} from "../config-schema.js";
import type { FleetConfig } from "../orchestration/lanes.js";
import { writeHearthConfig } from "../user-config.js";

type SectionOverrides = {
  server?: Partial<HearthConfig["server"]>;
  workspaces?: Partial<HearthConfig["workspaces"]>;
  storage?: Partial<HearthConfig["storage"]>;
  tools?: Partial<HearthConfig["tools"]>;
  ui?: Partial<HearthConfig["ui"]>;
  artifacts?: Partial<HearthConfig["artifacts"]>;
  skills?: Partial<HearthConfig["skills"]>;
  subagents?: HearthConfig["subagents"];
  fleet?: FleetConfig;
  tunnel?: Partial<HearthConfig["tunnel"]>;
  logging?: Partial<HearthConfig["logging"]>;
  oauth?: Partial<HearthConfig["oauth"]>;
};

export function writeTestHearthConfig(
  configDir: string,
  overrides: SectionOverrides = {},
): NodeJS.ProcessEnv {
  const defaults = defaultHearthConfig();
  const env = { HEARTH_CONFIG_DIR: configDir };
  writeHearthConfig({
    ...defaults,
    server: { ...defaults.server, ...overrides.server },
    workspaces: { ...defaults.workspaces, ...overrides.workspaces },
    storage: { ...defaults.storage, ...overrides.storage },
    tools: { ...defaults.tools, ...overrides.tools },
    ui: { ...defaults.ui, ...overrides.ui },
    artifacts: { ...defaults.artifacts, ...overrides.artifacts },
    skills: { ...defaults.skills, ...overrides.skills },
    subagents: overrides.subagents ?? defaults.subagents,
    fleet: overrides.fleet ?? defaults.fleet,
    tunnel: { ...defaults.tunnel, ...overrides.tunnel },
    logging: { ...defaults.logging, ...overrides.logging },
    oauth: { ...defaults.oauth, ...overrides.oauth },
  }, env);
  return {
    ...env,
    HEARTH_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
}
