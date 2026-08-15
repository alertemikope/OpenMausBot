import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePiMemoryMcp } from "./pi-memory.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-pi-memory-"));
  roots.push(root);
  const agent = join(root, "agent");
  const setup = join(root, "Pi_Setup");
  const bridge = join(setup, "dist", "mcp", "main.js");
  mkdirSync(join(setup, "dist", "mcp"), { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(bridge, "// bridge\n");
  return { agent, setup, bridge };
}

describe("Pi Memory Hub discovery", () => {
  it("uses an explicit existing bridge", () => {
    const { agent, bridge } = fixture();
    expect(resolvePiMemoryMcp(bridge, agent)).toBe(bridge);
  });

  it("discovers the local package configured by Pi", () => {
    const { agent, setup, bridge } = fixture();
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [setup] }));
    expect(resolvePiMemoryMcp(undefined, agent)).toBe(bridge);
  });

  it("fails closed when the configured package has no built MCP", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-pi-memory-missing-"));
    roots.push(root);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: [join(root, "missing")] }));
    expect(resolvePiMemoryMcp(join(root, "also-missing.js"), root)).toBeNull();
  });
});
