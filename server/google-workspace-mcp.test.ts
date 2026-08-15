import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MCP = fileURLToPath(new URL("./google-workspace-mcp.ts", import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Google Workspace gws MCP", () => {
  let dir: string;
  let fake: string;
  let child: ChildProcess;
  let buffer = "";
  let pending: Array<(message: any) => void> = [];

  const request = (id: number, method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5_000);
      pending.push((message) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-google-mcp-"));
    fake = join(dir, "gws");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='schema'){
 const write=/(create|update|append|send|delete)$/.test(a[1]);
 process.stdout.write(JSON.stringify({httpMethod:write?'POST':'GET',description:'fake schema'}));
}else process.stdout.write(JSON.stringify({ok:true,argv:a}));
`,
    );
    chmodSync(fake, 0o755);
    child = spawn(process.execPath, [MCP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENMAUSBOT_GWS_PATH: fake },
    });
    child.stdout!.on("data", (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        for (const resolve of [...pending]) resolve(message);
        pending = [];
      }
    });
  });

  afterEach(() => {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("advertises bounded read, write, schema, and Gmail send contracts", async () => {
    const initialized = await request(1, "initialize", { protocolVersion: "2025-03-26" });
    expect(initialized.result.serverInfo.name).toBe("openmausbot-google-workspace");
    const listed = await request(2, "tools/list");
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual([
      "google_workspace_schema",
      "google_workspace_read",
      "google_workspace_write",
      "google_gmail_send",
    ]);
    expect(listed.result.tools[1].annotations.readOnlyHint).toBe(true);
    expect(listed.result.tools[2].annotations.destructiveHint).toBe(true);
  });

  it("enforces the schema HTTP verb boundary before executing", async () => {
    const read = await request(1, "tools/call", {
      name: "google_workspace_read",
      arguments: { service: "drive", resource: "files", method: "list", params: { pageSize: 2 } },
    });
    expect(read.result.isError).toBeUndefined();
    expect(read.result.content[0].text).toContain("drive.files.list GET succeeded");
    const readPayload = JSON.parse(read.result.content[0].text.split("\n").slice(1).join("\n"));
    expect(JSON.parse(readPayload.argv[readPayload.argv.indexOf("--params") + 1])).toEqual({ pageSize: 2 });

    const wrong = await request(2, "tools/call", {
      name: "google_workspace_write",
      arguments: { service: "drive", resource: "files", method: "list" },
    });
    expect(wrong.result.isError).toBe(true);
    expect(wrong.result.content[0].text).toContain("use google_workspace_read");
  });

  it("passes structured write bodies and builds valid base64url Gmail MIME", async () => {
    const write = await request(1, "tools/call", {
      name: "google_workspace_write",
      arguments: {
        service: "calendar",
        resource: "events",
        method: "create",
        params: { calendarId: "primary" },
        body: { summary: "Test" },
      },
    });
    expect(write.result.isError).toBeUndefined();
    expect(write.result.content[0].text).toContain('calendar.events.create POST succeeded');
    const writePayload = JSON.parse(write.result.content[0].text.split("\n").slice(1).join("\n"));
    expect(JSON.parse(writePayload.argv[writePayload.argv.indexOf("--json") + 1])).toEqual({ summary: "Test" });

    const sent = await request(2, "tools/call", {
      name: "google_gmail_send",
      arguments: { to: ["person@example.com"], subject: "Bonjour", body_text: "Corps" },
    });
    expect(sent.result.isError).toBeUndefined();
    const output = sent.result.content[0].text as string;
    const payload = JSON.parse(output.slice(output.indexOf("\n") + 1));
    const body = JSON.parse(payload.argv[payload.argv.indexOf("--json") + 1]);
    const mime = Buffer.from(body.raw, "base64url").toString("utf8");
    expect(mime).toContain("To: person@example.com\r\nSubject: Bonjour");
    expect(mime).toContain("\r\n\r\nCorps");
  });
});
