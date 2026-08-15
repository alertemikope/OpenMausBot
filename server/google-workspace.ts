// Direct Google Workspace MCP integration. The MCP process delegates API
// discovery, OAuth refresh, and keychain-backed credential storage to the
// locally installed Google Workspace CLI (`gws`). No Google token crosses
// OpenMausBot's config or argv boundary.
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { augmentedPath } from "./env-path.ts";

export type StdioMcpIntegration = { command: string; args: string[]; env: Record<string, string> };

const mcpPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "google-workspace-mcp.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();

export function resolveGwsPath(
  override = process.env.OPENMAUSBOT_GWS_PATH,
  pathValue = augmentedPath(),
): string | null {
  if (override && isAbsolute(override) && existsSync(override)) return override;
  const executable = process.platform === "win32" ? "gws.exe" : "gws";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function googleWorkspaceIntegration(): StdioMcpIntegration | null {
  const gws = resolveGwsPath();
  if (!gws) return null;
  return {
    command: process.execPath,
    args: [mcpPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      OPENMAUSBOT_GWS_PATH: gws,
      PATH: augmentedPath(),
    },
  };
}
