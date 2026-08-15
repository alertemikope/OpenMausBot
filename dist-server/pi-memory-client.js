import { spawn } from "node:child_process";
import { piMemoryIntegration } from "./pi-memory.js";
function findId(value) {
    if (!value || typeof value !== "object")
        return undefined;
    if ("id" in value && typeof value.id === "string" && value.id)
        return value.id;
    for (const nested of Object.values(value)) {
        const found = findId(nested);
        if (found)
            return found;
    }
    return undefined;
}
/** Minimal one-shot MCP client for explicit user-confirmed memory mutations.
 * The bridge remains the only owner of credentials and canonical storage. */
export class PiMemoryMcpClient {
    integration;
    timeoutMs;
    constructor(integration = piMemoryIntegration(), timeoutMs = 15_000) {
        this.integration = integration;
        this.timeoutMs = timeoutMs;
    }
    async write(input) {
        const value = await this.call("memory_write", {
            content: input.content,
            type: input.type,
            scope: "shared",
            sensitivity: "internal",
            source: input.source,
            tags: ["openmausbot", "voice-confirmed"],
        });
        const id = findId(value);
        if (!id)
            throw new Error("Pi Memory did not return a canonical memory id");
        return { id };
    }
    async correct(input) {
        const value = await this.call("memory_correct", input);
        return { id: findId(value) ?? input.id };
    }
    async forget(id) {
        await this.call("memory_forget", { id });
    }
    async call(name, args) {
        if (!this.integration)
            throw Object.assign(new Error("Pi Memory Hub is unavailable"), { status: 503 });
        const child = spawn(this.integration.command, this.integration.args, {
            env: { ...process.env, ...this.integration.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let buffer = "";
        let stderr = "";
        const responses = new Map();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
        child.stdout.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0)
                    break;
                const line = buffer.slice(0, newline).replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                try {
                    const response = JSON.parse(line);
                    if (typeof response.id === "number")
                        responses.get(response.id)?.(response);
                }
                catch {
                    // Protocol stdout is JSONL. Ignore unrelated child output without
                    // reflecting it into application logs where it could contain data.
                }
            }
        });
        const request = (id, method, params) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                responses.delete(id);
                reject(new Error(`Pi Memory ${method} timed out`));
            }, this.timeoutMs);
            timer.unref?.();
            responses.set(id, (response) => {
                clearTimeout(timer);
                responses.delete(id);
                if (response.error)
                    reject(new Error(response.error.message || `Pi Memory ${method} failed`));
                else
                    resolve(response.result);
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
        try {
            await request(1, "initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "openmausbot", version: "0.1.17" },
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
            const raw = await request(2, "tools/call", { name, arguments: args });
            const text = raw.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;
            if (raw.isError)
                throw new Error(text || `Pi Memory ${name} failed`);
            if (!text)
                return raw;
            try {
                return JSON.parse(text);
            }
            catch {
                return { text };
            }
        }
        catch (error) {
            if (child.exitCode != null && stderr)
                throw new Error(`Pi Memory bridge exited: ${stderr.trim().slice(0, 500)}`);
            throw error;
        }
        finally {
            child.stdin.end();
            child.kill("SIGTERM");
        }
    }
}
