// Local Google Workspace MCP server backed by googleworkspace/cli (`gws`).
// `gws` owns OAuth refresh and encrypted keychain storage; this process only
// validates a bounded model-facing contract and forwards structured calls.
// stdout is the MCP channel — diagnostics belong on stderr.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const GWS = process.env.OPENMAUSBOT_GWS_PATH || "gws";
const MAX_OUTPUT = 30_000;
const SERVICES = [
    "gmail",
    "drive",
    "calendar",
    "sheets",
    "docs",
    "slides",
    "tasks",
    "people",
    "forms",
    "keep",
    "meet",
    "chat",
];
const SERVICE_SET = new Set(SERVICES);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;
const schemaCache = new Map();
const COMMON_PROPERTIES = {
    service: {
        type: "string",
        enum: SERVICES,
        description: "Google Workspace service",
    },
    resource: {
        type: "string",
        description: 'Dot-separated API resource, e.g. "users.messages", "files", "events", "spreadsheets.values"',
    },
    method: {
        type: "string",
        description: 'API method, e.g. "list", "get", "create", "update", "append"',
    },
    params: {
        type: "object",
        description: "Path/query parameters from google_workspace_schema. Use userId=me and calendarId=primary when appropriate",
        additionalProperties: true,
    },
};
export const TOOLS = [
    {
        name: "google_workspace_schema",
        description: "Inspect one Google Workspace API method before calling it. Returns required parameters, request-body schema, and whether the method reads or writes",
        inputSchema: {
            type: "object",
            properties: {
                service: COMMON_PROPERTIES.service,
                resource: COMMON_PROPERTIES.resource,
                method: COMMON_PROPERTIES.method,
            },
            required: ["service", "resource", "method"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
        name: "google_workspace_read",
        description: "Run one read-only Google Workspace API method through the user's local OAuth. Only GET/HEAD methods are accepted; set small page limits and use returned page tokens for more",
        inputSchema: {
            type: "object",
            properties: COMMON_PROPERTIES,
            required: ["service", "resource", "method"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
        name: "google_workspace_write",
        description: "Run one mutating Google Workspace API method through the user's local OAuth. Call google_workspace_schema first; this can create, update, send, move, or delete data",
        inputSchema: {
            type: "object",
            properties: {
                ...COMMON_PROPERTIES,
                body: {
                    type: "object",
                    description: "JSON request body required by the selected method",
                    additionalProperties: true,
                },
            },
            required: ["service", "resource", "method"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
        name: "google_gmail_send",
        description: "Send one plain-text email from the authenticated Gmail account. Returns the Gmail message and thread IDs; use google_workspace_write for drafts or advanced MIME",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25, description: "Recipient email addresses" },
                subject: { type: "string", minLength: 1, maxLength: 998 },
                body_text: { type: "string", description: "Plain-text message body" },
                cc: { type: "array", items: { type: "string" }, maxItems: 25 },
                bcc: { type: "array", items: { type: "string" }, maxItems: 25 },
            },
            required: ["to", "subject", "body_text"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
];
function plainObject(value, label) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be a JSON object`);
    return value;
}
function target(args) {
    const service = String(args.service ?? "");
    const resource = String(args.resource ?? "");
    const method = String(args.method ?? "");
    if (!SERVICE_SET.has(service))
        throw new Error(`Unsupported Google Workspace service: ${service || "(missing)"}`);
    const parts = resource.split(".");
    if (!resource || parts.some((part) => !IDENTIFIER.test(part))) {
        throw new Error('resource must be dot-separated API identifiers such as "users.messages"');
    }
    if (!IDENTIFIER.test(method))
        throw new Error("method must be an API identifier such as list, get, create, or update");
    return { service, resource, method, dotted: `${service}.${resource}.${method}` };
}
async function gws(args, timeout = 60_000) {
    try {
        const { stdout } = await run(GWS, args, {
            encoding: "utf8",
            timeout,
            maxBuffer: 2 * 1024 * 1024,
            env: process.env,
        });
        return stdout;
    }
    catch (error) {
        const failure = error;
        const detail = String(failure.stderr || failure.stdout || failure.message).trim().slice(0, 2_000);
        if (/auth|credential|token|keyring|oauth/i.test(detail)) {
            throw new Error(`Google Workspace authentication failed. Run "gws auth login" in Terminal, then retry. ${detail}`);
        }
        throw new Error(`gws ${args.slice(0, 4).join(" ")} failed${failure.code ? ` (${failure.code})` : ""}: ${detail}`);
    }
}
async function methodSchema(dotted) {
    const cached = schemaCache.get(dotted);
    if (cached)
        return cached;
    let parsed;
    try {
        parsed = JSON.parse(await gws(["schema", dotted]));
    }
    catch (error) {
        throw new Error(`Unknown or unavailable Google Workspace method ${dotted}. ${error.message}`);
    }
    if (!parsed.httpMethod)
        throw new Error(`Google Workspace schema ${dotted} did not declare an HTTP method`);
    schemaCache.set(dotted, parsed);
    return parsed;
}
function bounded(text) {
    const trimmed = text.trim();
    if (trimmed.length <= MAX_OUTPUT)
        return trimmed || "{}";
    return `${trimmed.slice(0, MAX_OUTPUT)}\n[truncated after ${MAX_OUTPUT} characters; narrow fields/page size or continue with the returned page token]`;
}
async function apiCall(args, write) {
    const t = target(args);
    const schema = await methodSchema(t.dotted);
    const verb = String(schema.httpMethod).toUpperCase();
    const reads = verb === "GET" || verb === "HEAD";
    if (write && reads)
        throw new Error(`${t.dotted} is ${verb}; use google_workspace_read`);
    if (!write && !reads)
        throw new Error(`${t.dotted} is ${verb}; use google_workspace_write because it may change Google data`);
    const params = plainObject(args.params, "params");
    const body = plainObject(args.body, "body");
    if (!write && body)
        throw new Error("google_workspace_read does not accept a request body");
    const command = [t.service, ...t.resource.split("."), t.method];
    if (params)
        command.push("--params", JSON.stringify(params));
    if (body)
        command.push("--json", JSON.stringify(body));
    const output = await gws(command);
    return `${t.dotted} ${verb} succeeded\n${bounded(output)}`;
}
function addressList(value, label, allowEmpty = false) {
    if (!Array.isArray(value) || (!allowEmpty && !value.length)) {
        throw new Error(`${label} must contain at least one email address`);
    }
    const addresses = value.map(String).map((entry) => entry.trim());
    if (addresses.some((entry) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))) {
        throw new Error(`${label} contains an invalid email address`);
    }
    return addresses;
}
async function gmailSend(args) {
    const to = addressList(args.to, "to");
    const cc = args.cc === undefined ? [] : addressList(args.cc, "cc", true);
    const bcc = args.bcc === undefined ? [] : addressList(args.bcc, "bcc", true);
    const subject = String(args.subject ?? "").replace(/[\r\n]+/g, " ").trim();
    const body = String(args.body_text ?? "");
    if (!subject)
        throw new Error("subject is required");
    const headers = [
        `To: ${to.join(", ")}`,
        ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
        ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
    ];
    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
    const output = await gws([
        "gmail", "users", "messages", "send",
        "--params", JSON.stringify({ userId: "me" }),
        "--json", JSON.stringify({ raw }),
    ]);
    return `Gmail message sent to ${to.join(", ")}\n${bounded(output)}`;
}
export async function callTool(name, args) {
    if (name === "google_workspace_schema") {
        const t = target(args);
        return `${t.dotted}\n${bounded(await gws(["schema", t.dotted]))}`;
    }
    if (name === "google_workspace_read")
        return apiCall(args, false);
    if (name === "google_workspace_write")
        return apiCall(args, true);
    if (name === "google_gmail_send")
        return gmailSend(args);
    throw new Error(`Unknown tool: ${name}`);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, text, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
async function handle(message) {
    const id = message.id;
    const method = String(message.method ?? "");
    const params = (message.params ?? {});
    if (method === "initialize") {
        send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: String(params.protocolVersion ?? "2024-11-05"),
                capabilities: { tools: {} },
                serverInfo: { name: "openmausbot-google-workspace", version: "1.0.0" },
            },
        });
        return;
    }
    if (method === "tools/list")
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
        try {
            result(id, await callTool(String(params.name ?? ""), plainObject(params.arguments, "arguments") ?? {}));
        }
        catch (error) {
            result(id, error.message, true);
        }
        return;
    }
    if (method === "ping")
        return send({ jsonrpc: "2.0", id, result: {} });
    if (method.startsWith("notifications/"))
        return;
    if (id !== undefined)
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
let buffer = "";
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line)
            continue;
        try {
            const message = JSON.parse(line);
            void handle(message);
        }
        catch {
            /* malformed input is not an MCP request */
        }
    }
});
process.stdin.on("end", () => process.exit(0));
