// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computerProxyEnv } from "../container-computer.js";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.js";
import { newEventId, newId } from "../contracts.js";
import { augmentedPath } from "../env-path.js";
import { appendNative } from "./native.js";
const DRIVER_KIND = "codex";
// catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
    default: "gpt-5.6-sol",
    options: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.4", label: "GPT-5.4" },
    ],
};
function decodeConfig(raw) {
    const o = (raw ?? {});
    return {
        cli: typeof o.cli === "string" ? o.cli : "codex",
        fullAuto: o.fullAuto === true,
    };
}
const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE = "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const COMPOSIO_KEY_ENV = "OPENMAUSBOT_COMPOSIO_KEY";
const COMPUTER_PROXY_PATH = (() => {
    const ts = join(dirname(fileURLToPath(import.meta.url)), "..", "computer-proxy.ts");
    return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
const MAX_SESSION_SCAN_BYTES = 64 * 1024 * 1024;
function findSessionFile(root, cursor) {
    if (!existsSync(root) || cursor.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(cursor))
        return null;
    const pending = [root];
    let visited = 0;
    while (pending.length && visited < 20_000) {
        const dir = pending.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            visited += 1;
            const target = join(dir, entry.name);
            if (entry.isDirectory())
                pending.push(target);
            else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(cursor))
                return target;
        }
    }
    return null;
}
/** Codex can persist a custom tool call before its output and then be killed.
 * Resuming such a rollout currently makes app-server log an error and exit 0
 * without returning a JSON-RPC error. Detect that local history before resume
 * so the logical user turn can start on a clean native thread instead. */
export function danglingCustomToolCall(cursor, codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")) {
    const file = findSessionFile(join(codexHome, "sessions"), cursor);
    if (!file)
        return null;
    try {
        if (statSync(file).size > MAX_SESSION_SCAN_BYTES)
            return null;
        const pending = new Set();
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line)
                continue;
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (record?.type !== "response_item")
                continue;
            const payload = record.payload ?? {};
            if (payload.type === "custom_tool_call" && typeof payload.call_id === "string") {
                pending.add(payload.call_id);
            }
            else if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
                pending.delete(payload.call_id);
            }
        }
        return pending.values().next().value ?? null;
    }
    catch {
        return null;
    }
}
/** Add one stdio MCP server to Codex without putting credentials in argv.
 * env_vars tells Codex which inherited variables to forward to that server. */
function appendStdioMcp(args, env, name, server) {
    Object.assign(env, server.env);
    args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(server.command)}`, "-c", `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, "-c", `mcp_servers.${name}.env_vars=${JSON.stringify(Object.keys(server.env))}`);
}
/** Codex app-server inherits the user's normal MCP config, but OpenMausBot's
 * Composio credential is app-owned and intentionally absent from that file.
 * Add a per-process MCP override and pass the secret through an environment
 * header reference so it never appears in argv or Codex's config on disk. */
function appServerArgs(turn, env) {
    const args = [];
    const composio = turn.integrations?.composio;
    if (composio?.key) {
        env[COMPOSIO_KEY_ENV] = composio.key;
        const url = composio.url || "https://connect.composio.dev/mcp";
        args.push("-c", `mcp_servers.composio.url=${JSON.stringify(url)}`, "-c", `mcp_servers.composio.env_http_headers={\"x-consumer-api-key\"=\"${COMPOSIO_KEY_ENV}\"}`);
    }
    const pennylane = turn.integrations?.pennylane;
    if (pennylane) {
        appendStdioMcp(args, env, "pennylane", pennylane);
    }
    const googleWorkspace = turn.integrations?.googleWorkspace;
    if (googleWorkspace) {
        appendStdioMcp(args, env, "google_workspace", googleWorkspace);
    }
    const memory = turn.integrations?.memory;
    if (memory) {
        appendStdioMcp(args, env, "pi_memory", memory);
    }
    // Both explicit computer destinations use the same MCP name. A cloud box
    // rides OpenMausBot's REST bridge; This Mac and Local VM hand Codex Cua
    // Driver's official stdio MCP contract directly.
    if (turn.integrations?.computer) {
        appendStdioMcp(args, env, "computer", {
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: { ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(turn.integrations.computer) },
        });
    }
    else if (turn.integrations?.localComputer) {
        appendStdioMcp(args, env, "computer", turn.integrations.localComputer);
    }
    args.push("app-server");
    return args;
}
export const CodexDriver = {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Codex", supportsMultipleInstances: true },
    install: {
        command: {
            darwin: "npm install -g @openai/codex",
            linux: "npm install -g @openai/codex",
            win32: "npm install -g @openai/codex",
        },
        needsNode: true,
        docsUrl: "https://github.com/openai/codex",
        signInCommand: "codex",
    },
    models: MODELS,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    async create(input) {
        const { instanceId, config } = input;
        const listeners = new Set();
        const active = new Map();
        const emit = (event) => {
            for (const l of [...listeners])
                l(event);
        };
        const base = (threadId, turnId) => ({
            eventId: newEventId(),
            provider: DRIVER_KIND,
            threadId,
            turnId,
            createdAt: new Date().toISOString(),
        });
        const sendTurn = async (turn) => {
            const { threadId } = turn;
            if (active.has(threadId))
                throw new Error("a turn is already running on this thread");
            const turnId = newId();
            const env = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
            // the CLI owns its own ChatGPT login; a leaked API key silently flips
            // billing to pay-as-you-go (agentcal)
            delete env.OPENAI_API_KEY;
            const child = spawnCli(config.cli, appServerArgs(turn, env), {
                cwd: turn.cwd ?? homedir(),
                env,
                stdio: ["pipe", "pipe", "pipe"],
            });
            const state = { settled: false, lastText: "", sawStreamDelta: false };
            let resolveTerminal;
            const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
            const asks = new Map();
            let nextId = 1;
            const rpcPending = new Map();
            const send = (obj) => {
                try {
                    child.stdin.write(JSON.stringify(obj) + "\n");
                }
                catch { }
                appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
            };
            const request = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
                const id = nextId++;
                // a wedged app-server can accept stdin and never reply; without this
                // the handshake await hangs forever and the bot stays busy for good
                const timer = setTimeout(() => {
                    if (rpcPending.delete(id))
                        reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                if (typeof timer.unref === "function")
                    timer.unref();
                rpcPending.set(id, {
                    resolve: (v) => {
                        clearTimeout(timer);
                        resolve(v);
                    },
                    reject: (e) => {
                        clearTimeout(timer);
                        reject(e);
                    },
                });
                send({ jsonrpc: "2.0", id, method, params });
            });
            let codexThreadId = null;
            let codexTurnId = null;
            const steer = async (text) => {
                if (!codexThreadId)
                    return { accepted: false, reason: "Codex has not started its thread yet." };
                if (!codexTurnId)
                    return { accepted: false, reason: "Codex has not started its turn yet." };
                try {
                    await request("turn/steer", {
                        threadId: codexThreadId,
                        expectedTurnId: codexTurnId,
                        input: [{ type: "text", text, text_elements: [] }],
                    });
                    return { accepted: true };
                }
                catch (error) {
                    return { accepted: false, reason: error instanceof Error ? error.message : "Codex rejected steering." };
                }
            };
            const stop = async () => {
                if (!state.settled && codexThreadId && codexTurnId) {
                    try {
                        await request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId }, 5_000);
                        await Promise.race([
                            terminal,
                            new Promise((resolve) => {
                                const timer = setTimeout(resolve, 5_000);
                                timer.unref?.();
                            }),
                        ]);
                    }
                    catch {
                        // A dead app-server still needs a bounded hard-stop fallback.
                    }
                }
                killCliTree(child);
            };
            const settle = (ok, stopReason) => {
                if (state.settled)
                    return;
                state.settled = true;
                resolveTerminal();
                for (const finish of [...asks.values()])
                    finish("deny", "OpenMausBot: the turn ended");
                for (const p of rpcPending.values())
                    p.reject(new Error("turn settled"));
                rpcPending.clear();
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
                void stop(); // the app-server never exits on its own
            };
            // server→client approval request → canonical request.opened
            const handleServerRequest = (msg) => {
                const method = msg.method;
                const params = msg.params ?? {};
                const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
                const isMcpElicitation = method === "mcpServer/elicitation/request";
                const isMcpApproval = isMcpElicitation && params._meta?.codex_approval_kind === "mcp_tool_call";
                const isQuestion = method === "item/tool/requestUserInput" || (isMcpElicitation && !isMcpApproval);
                const mcpTool = typeof params.message === "string" ? params.message.match(/run tool ["“]([^"”]+)["”]/i)?.[1] : undefined;
                const tool = method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
                    ? "edit"
                    : isMcpApproval
                        ? `mcp:${params.serverName || "server"}/${mcpTool || "tool"}`
                        : isQuestion
                            ? "ask_user"
                            : "shell";
                if (config.fullAuto && !isQuestion) {
                    if (isMcpApproval) {
                        return send({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: {}, _meta: null } });
                    }
                    return send({ jsonrpc: "2.0", id: msg.id, result: { decision: legacy ? "approved" : "accept" } });
                }
                const requestId = newId();
                const summary = typeof params.command === "string"
                    ? params.command.slice(0, 200)
                    : Array.isArray(params.questions)
                        ? params.questions.map((q) => q.question ?? q.header).filter(Boolean).join(" · ")
                        : typeof params.message === "string"
                            ? params.message.slice(0, 300)
                            : typeof params.reason === "string"
                                ? params.reason
                                : tool;
                const choices = isQuestion
                    ? (params.questions?.[0]?.options ?? []).map((o) => o.label).slice(0, 5)
                    : undefined;
                const finish = (behavior, message) => {
                    if (!asks.delete(requestId))
                        return;
                    clearTimeout(timer);
                    if (isQuestion) {
                        const answers = {};
                        for (const q of Array.isArray(params.questions) ? params.questions : []) {
                            answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
                        }
                        send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
                    }
                    else {
                        const result = isMcpApproval
                            ? { action: behavior === "allow" ? "accept" : "decline", content: behavior === "allow" ? {} : null, _meta: null }
                            : { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" };
                        send({ jsonrpc: "2.0", id: msg.id, result });
                    }
                    emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source: "user" });
                };
                const timer = setTimeout(() => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE) : finish("deny", DENY_TIMEOUT_NOTE)), 15 * 60_000);
                timer.unref?.();
                asks.set(requestId, finish);
                emit({
                    ...base(threadId, turnId),
                    type: "request.opened",
                    requestId,
                    requestType: isQuestion ? "question" : "permission",
                    tool,
                    summary,
                    choices,
                });
            };
            const handleNotification = (msg) => {
                const p = msg.params ?? {};
                switch (msg.method) {
                    // token-level chat text; the item/completed frame follows with the
                    // whole message, so its delta is only a fallback when none streamed
                    case "item/agentMessage/delta": {
                        const delta = typeof p.delta === "string" ? p.delta : "";
                        if (delta) {
                            state.sawStreamDelta = true;
                            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
                        }
                        break;
                    }
                    case "item/reasoning/textDelta":
                    case "item/reasoning/summaryTextDelta": {
                        const delta = typeof p.delta === "string" ? p.delta : "";
                        if (delta)
                            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
                        break;
                    }
                    case "item/started": {
                        const item = p.item ?? {};
                        const title = item.type === "commandExecution"
                            ? String(item.command ?? "shell").slice(0, 80)
                            : item.type === "fileChange"
                                ? "edit"
                                : item.type === "mcpToolCall"
                                    ? (item.tool ?? item.name ?? "mcp")
                                    : item.type === "webSearch"
                                        ? "web_search"
                                        : null;
                        if (title)
                            emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
                        break;
                    }
                    case "item/completed": {
                        const item = p.item ?? {};
                        if (item.type === "agentMessage") {
                            if (item.text?.trim()) {
                                state.lastText = item.text;
                                if (!state.sawStreamDelta) {
                                    emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                                }
                                state.sawStreamDelta = false;
                                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
                            }
                        }
                        else if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
                            emit({
                                ...base(threadId, turnId),
                                type: "item.completed",
                                itemType: "tool",
                                itemId: item.id,
                                ok: item.status !== "failed" && item.status !== "declined",
                            });
                        }
                        else if (item.type === "reasoning") {
                            emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
                        }
                        break;
                    }
                    case "thread/tokenUsage/updated": {
                        const t = p.tokenUsage?.total;
                        if (t) {
                            emit({
                                ...base(threadId, turnId),
                                type: "thread.token-usage.updated",
                                input: t.inputTokens ?? 0,
                                output: t.outputTokens ?? 0,
                            });
                        }
                        break;
                    }
                    case "turn/completed": {
                        const t = p.turn ?? {};
                        settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
                        break;
                    }
                    case "error":
                        // shape drift: 0.144 sends {message}, 0.139 nests it under
                        // {error:{message}} — surface either (agentcal armor)
                        {
                            const message = p.message ?? p.error?.message;
                            if (message)
                                emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400) });
                        }
                        break;
                }
            };
            let buf = "";
            // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
            // multibyte characters that straddle two reads and corrupts the text
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line.trim())
                        continue;
                    let msg;
                    try {
                        msg = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
                    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
                        const pend = rpcPending.get(msg.id);
                        if (pend) {
                            rpcPending.delete(msg.id);
                            msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
                        }
                    }
                    else if (msg.id !== undefined && msg.method) {
                        handleServerRequest(msg);
                    }
                    else if (msg.method) {
                        handleNotification(msg);
                    }
                }
            });
            let stderr = "";
            child.stderr.on("data", (c) => {
                stderr += c;
                if (stderr.length > 8192)
                    stderr = stderr.slice(-8192);
            });
            child.on("error", (e) => {
                emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
                settle(false, "spawn_error");
            });
            child.on("close", (code) => {
                if (!state.settled) {
                    emit({
                        ...base(threadId, turnId),
                        type: "runtime.error",
                        message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
                    });
                    settle(false, "exit_before_result");
                }
            });
            active.set(threadId, { stop, steer, turnId, asks });
            emit({ ...base(threadId, turnId), type: "turn.started" });
            // handshake + kickoff; any refusal surfaces as failure, not a hang
            (async () => {
                try {
                    await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
                    send({ jsonrpc: "2.0", method: "initialized", params: {} });
                    const requestedCursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
                    const orphanedCall = requestedCursor ? danglingCustomToolCall(requestedCursor) : null;
                    const cursor = orphanedCall ? null : requestedCursor;
                    if (orphanedCall) {
                        appendNative(threadId, {
                            dir: "in",
                            source: "codex.history-recovery",
                            msg: { skippedCursor: requestedCursor, orphanedCall },
                        });
                    }
                    let startedModel = null;
                    if (cursor) {
                        try {
                            const resumed = await request("thread/resume", { threadId: cursor });
                            codexThreadId = resumed?.thread?.id ?? cursor;
                        }
                        catch {
                            /* resume unsupported or thread gone — start fresh below */
                        }
                    }
                    if (!codexThreadId) {
                        const started = await request("thread/start", {
                            cwd: turn.cwd ?? homedir(),
                            model: turn.model || null,
                            sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
                            approvalPolicy: config.fullAuto ? "never" : "on-request",
                            ephemeral: false,
                        });
                        codexThreadId = started?.thread?.id ?? null;
                        startedModel = started?.model ?? null;
                    }
                    emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
                    const turnInput = [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }];
                    let startedTurn;
                    try {
                        startedTurn = await request("turn/start", { threadId: codexThreadId, input: turnInput });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const brokenConversation = /custom tool call output is missing|dangling_tool_call|function call.*missing.*output/iu.test(message);
                        if (!cursor || !brokenConversation)
                            throw error;
                        // An interrupted MCP/custom-tool call can leave a persisted Codex
                        // thread unreplayable. Fail closed on arbitrary errors, but for
                        // this exact provider state start a clean native thread and retry
                        // once so future turns are not permanently bricked.
                        const recovered = await request("thread/start", {
                            cwd: turn.cwd ?? homedir(),
                            model: turn.model || null,
                            sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
                            approvalPolicy: config.fullAuto ? "never" : "on-request",
                            ephemeral: false,
                        });
                        codexThreadId = recovered?.thread?.id ?? null;
                        if (!codexThreadId)
                            throw error;
                        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: recovered?.model ?? turn.model ?? null });
                        startedTurn = await request("turn/start", { threadId: codexThreadId, input: turnInput });
                    }
                    codexTurnId = startedTurn?.turn?.id ?? startedTurn?.id ?? null;
                }
                catch (e) {
                    if (!state.settled) {
                        emit({ ...base(threadId, turnId), type: "runtime.error", message: e.message });
                        settle(false, "rpc_error");
                    }
                }
            })();
            return { turnId };
        };
        const snapshot = async () => {
            const version = await new Promise((resolve) => {
                execCli(config.cli, ["--version"], { timeout: 8000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => resolve(err ? null : stdout.trim()));
            });
            if (!version)
                return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
            return { state: "available", version };
        };
        return {
            instanceId,
            driverKind: DRIVER_KIND,
            displayName: input.displayName,
            enabled: input.enabled,
            models: MODELS,
            snapshot,
            adapter: {
                provider: DRIVER_KIND,
                capabilities: {
                    sessionModelSwitch: "unsupported",
                    stdioMcp: true,
                    computerMcp: true,
                    // Access to the host Mac is powerful. Expose both explicit choices
                    // in the UI, but never attach This Mac merely because a bot omitted
                    // its destination setting.
                    implicitHostComputer: false,
                    steering: true,
                },
                sendTurn,
                interruptTurn: async (threadId) => { await active.get(threadId)?.stop(); },
                steerTurn: async (threadId, _turnId, text) => active.get(threadId)?.steer(text) ?? { accepted: false, reason: "No active Codex turn." },
                respondToRequest: async (threadId, requestId, decision) => {
                    const turn = active.get(threadId);
                    const finish = turn?.asks.get(requestId);
                    if (!finish)
                        throw new Error("no such pending request");
                    finish(decision.behavior, decision.message);
                },
                hasSession: (threadId) => active.has(threadId),
                stopAll: async () => {
                    await Promise.all([...active.values()].map(({ stop }) => stop()));
                },
                onEvent: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            dispose: async () => {
                await Promise.all([...active.values()].map(({ stop }) => stop()));
                listeners.clear();
            },
        };
    },
};
