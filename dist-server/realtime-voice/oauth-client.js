import { randomUUID } from "node:crypto";
function responseFrom(value) {
    const unwrapped = value && typeof value === "object" && "data" in value
        ? value.data
        : value;
    if (!unwrapped || typeof unwrapped !== "object")
        return undefined;
    const message = unwrapped;
    return message.type === "openmaus:oauth-response" && typeof message.requestId === "string"
        ? message
        : undefined;
}
export class ElectronOAuthClient {
    port;
    timeoutMs;
    constructor(port = process.parentPort, timeoutMs = 15_000) {
        this.port = port;
        this.timeoutMs = timeoutMs;
    }
    resolveAccess(signal) {
        const port = this.port;
        if (!port)
            throw new Error("ChatGPT OAuth is available in the OpenMausBot desktop app");
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                port.off("message", onMessage);
            };
            const fail = (error) => { cleanup(); reject(error); };
            const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("OAuth request cancelled"));
            const onMessage = (event) => {
                const message = responseFrom(event);
                if (!message || message.requestId !== requestId)
                    return;
                if (!message.ok || !message.accessToken || !message.accountId) {
                    fail(new Error(message.error || "ChatGPT is not connected"));
                    return;
                }
                cleanup();
                resolve({ accessToken: message.accessToken, accountId: message.accountId });
            };
            const timer = setTimeout(() => fail(new Error("ChatGPT OAuth broker timed out")), this.timeoutMs);
            timer.unref?.();
            port.on("message", onMessage);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted)
                return onAbort();
            port.postMessage({ type: "openmaus:oauth-request", requestId });
        });
    }
}
