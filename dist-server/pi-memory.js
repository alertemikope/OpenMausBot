// Optional bridge to the user's canonical Pi Memory Hub. The MCP server
// remains owned by Pi_Setup: OpenMausBot only discovers and launches it, so
// Obsidian stays the source of truth and Qdrant stays a derived LAN index.
// The bearer token is deliberately absent here; the child resolves it from
// the macOS Keychain (or Pi Memory Hub's mode-600 client file).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { augmentedPath } from "./env-path.js";
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
function validBridge(path) {
    if (typeof path !== "string" || !path.trim())
        return null;
    const candidate = resolve(path.replace(/^~(?=\/)/, homedir()));
    return isAbsolute(candidate) && existsSync(candidate) ? candidate : null;
}
/** Locate Pi Memory Hub without copying its backend or credentials. An
 * explicit override wins; otherwise use Pi's configured local package and
 * finally the normal deployment locations on macOS/Linux. */
export function resolvePiMemoryMcp(override = process.env.OPENMAUSBOT_PI_MEMORY_MCP, piAgentDir = agentDir()) {
    // An explicit override is authoritative: a typo must disable the optional
    // bridge rather than silently selecting a different installation.
    if (override !== undefined)
        return validBridge(override);
    try {
        const settings = JSON.parse(readFileSync(join(piAgentDir, "settings.json"), "utf8"));
        if (Array.isArray(settings.packages)) {
            for (const entry of settings.packages) {
                if (typeof entry !== "string" || /^(?:npm:|git:|https?:)/.test(entry))
                    continue;
                const root = resolve(piAgentDir, entry.replace(/^~(?=\/)/, homedir()));
                const candidate = validBridge(join(root, "dist", "mcp", "main.js"));
                if (candidate)
                    return candidate;
            }
        }
    }
    catch {
        // Missing or malformed Pi settings simply means this optional bridge is
        // unavailable; OpenMausBot must still start normally.
    }
    for (const candidate of [
        join(homedir(), "Documents", "Dev", "Pi_Setup", "dist", "mcp", "main.js"),
        join(homedir(), ".local", "share", "pi-memory-hub", "app", "dist", "mcp", "main.js"),
    ]) {
        const found = validBridge(candidate);
        if (found)
            return found;
    }
    return null;
}
export function piMemoryIntegration() {
    const bridge = resolvePiMemoryMcp();
    if (!bridge)
        return null;
    return {
        command: process.execPath,
        args: [bridge],
        env: {
            ELECTRON_RUN_AS_NODE: "1",
            PI_CODING_AGENT_DIR: agentDir(),
            PATH: augmentedPath(),
        },
    };
}
