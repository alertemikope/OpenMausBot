import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PiMemoryMcpClient } from "./pi-memory-client.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi Memory MCP mutation client", () => {
  it("initializes MCP and invokes only the requested canonical memory tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-memory-mcp-"));
    roots.push(root);
    const script = join(root, "fake-memory.mjs");
    writeFileSync(script, `
      import readline from 'node:readline';
      const lines = readline.createInterface({ input: process.stdin });
      for await (const line of lines) {
        const request = JSON.parse(line);
        if (!request.id) continue;
        if (request.method === 'initialize') {
          console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }));
          continue;
        }
        const name = request.params.name;
        const id = name === 'memory_write' ? 'memory-written' : name === 'memory_correct' ? 'memory-corrected' : 'memory-forgotten';
        console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ id, args: request.params.arguments }) }] } }));
      }
    `);
    chmodSync(script, 0o700);
    const client = new PiMemoryMcpClient({ command: process.execPath, args: [script], env: {} }, 2_000);

    await expect(client.write({ content: "User prefers concise replies", type: "preference", source: "confirmed call" }))
      .resolves.toEqual({ id: "memory-written" });
    await expect(client.correct({ id: "memory-written", content: "User prefers very concise replies", reason: "correction" }))
      .resolves.toEqual({ id: "memory-corrected" });
    await expect(client.forget("memory-corrected")).resolves.toBeUndefined();
  });

  it("fails closed when the canonical bridge is unavailable", async () => {
    const client = new PiMemoryMcpClient(null);
    await expect(client.write({ content: "x", type: "fact", source: "test" })).rejects.toThrow(/unavailable/i);
  });
});

