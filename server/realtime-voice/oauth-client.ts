import { randomUUID } from "node:crypto";

import type { OAuthAccess, OAuthAccessProvider } from "./contracts.ts";

type ParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data?: unknown } | unknown) => void): void;
  off(event: "message", listener: (event: { data?: unknown } | unknown) => void): void;
};

type OAuthResponse = {
  type: "openmaus:oauth-response";
  requestId: string;
  ok: boolean;
  accessToken?: string;
  accountId?: string;
  error?: string;
};

function responseFrom(value: unknown): OAuthResponse | undefined {
  const unwrapped = value && typeof value === "object" && "data" in value
    ? (value as { data?: unknown }).data
    : value;
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const message = unwrapped as Record<string, unknown>;
  return message.type === "openmaus:oauth-response" && typeof message.requestId === "string"
    ? (message as OAuthResponse)
    : undefined;
}

export class ElectronOAuthClient implements OAuthAccessProvider {
  private readonly port: ParentPort | undefined;
  private readonly timeoutMs: number;

  constructor(
    port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort,
    timeoutMs = 15_000,
  ) {
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  resolveAccess(signal?: AbortSignal): Promise<OAuthAccess> {
    const port = this.port;
    if (!port) throw new Error("ChatGPT OAuth is available in the OpenMausBot desktop app");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        port.off("message", onMessage);
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("OAuth request cancelled"));
      const onMessage = (event: { data?: unknown } | unknown) => {
        const message = responseFrom(event);
        if (!message || message.requestId !== requestId) return;
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
      if (signal?.aborted) return onAbort();
      port.postMessage({ type: "openmaus:oauth-request", requestId });
    });
  }
}
