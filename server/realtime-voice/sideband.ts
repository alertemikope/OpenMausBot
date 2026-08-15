import { randomBytes, createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { EventEmitter } from "node:events";

import type { OAuthAccess } from "./contracts.ts";
import { liveAuthHeaders, type LiveRequestIds } from "./openai-live-wire.ts";

const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_EARLY_FRAMES = 32;
const MAX_EARLY_BYTES = 1024 * 1024;
const OPEN = 1;
const CLOSED = 3;

export interface LiveSidebandSocket {
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (payload: string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  off(event: "message", listener: (payload: string) => void): this;
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const header = payload.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : payload.length <= 0xffff
      ? Buffer.from([0x80 | opcode, 0xfe, payload.length >> 8, payload.length & 0xff])
      : (() => {
          const value = Buffer.alloc(10);
          value[0] = 0x80 | opcode;
          value[1] = 0xff;
          value.writeBigUInt64BE(BigInt(payload.length), 2);
          return value;
        })();
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

class NodeLiveSidebandSocket extends EventEmitter implements LiveSidebandSocket {
  readyState = OPEN;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private earlyMessages: string[] = [];
  private earlyBytes = 0;
  private readonly socket: import("node:stream").Duplex;

  constructor(socket: import("node:stream").Duplex) {
    super();
    this.socket = socket;
    // A TLS socket can fail before the broker attaches its owner listener;
    // keep EventEmitter's special `error` event from crashing the harness.
    this.on("error", () => {});
    socket.on("data", (chunk: Buffer) => this.consume(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => {
      this.readyState = CLOSED;
      this.emit("close");
    });
  }

  send(payload: string): void {
    if (this.readyState !== OPEN) throw new Error("GPT-Live sideband is closed");
    this.socket.write(clientFrame(0x1, Buffer.from(payload)));
  }

  override on(event: "message", listener: (payload: string) => void): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: "close", listener: () => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "message" && this.earlyMessages.length) {
      const messages = this.earlyMessages;
      this.earlyMessages = [];
      this.earlyBytes = 0;
      queueMicrotask(() => {
        for (const message of messages) this.emit("message", message);
      });
    }
    return this;
  }

  close(code = 1000, reason = "session closed"): void {
    if (this.readyState !== OPEN) return;
    const text = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.socket.write(clientFrame(0x8, payload));
    this.socket.end();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      if (second & 0x80) return this.fail(new Error("GPT-Live sideband returned a masked server frame"));
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(MAX_PAYLOAD)) return this.fail(new Error("GPT-Live sideband frame is too large"));
        length = Number(large);
        offset = 10;
      }
      if (length > MAX_PAYLOAD) return this.fail(new Error("GPT-Live sideband frame is too large"));
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      const final = Boolean(first & 0x80);
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.socket.write(clientFrame(0xa, payload));
        continue;
      }
      if (opcode !== 0x0 && opcode !== 0x1) return this.fail(new Error("GPT-Live sideband returned unsupported binary data"));
      this.fragments.push(Buffer.from(payload));
      if (!final) continue;
      const message = Buffer.concat(this.fragments);
      this.fragments = [];
      if (message.length > MAX_PAYLOAD) return this.fail(new Error("GPT-Live sideband message is too large"));
      const text = message.toString("utf8");
      if (this.listenerCount("message") === 0) {
        this.earlyBytes += message.length;
        this.earlyMessages.push(text);
        if (this.earlyMessages.length > MAX_EARLY_FRAMES || this.earlyBytes > MAX_EARLY_BYTES) {
          return this.fail(new Error("GPT-Live sideband startup buffer exceeded"));
        }
      } else {
        this.emit("message", text);
      }
    }
  }

  private fail(error: Error): void {
    this.emit("error", error);
    this.socket.destroy();
  }
}

function connectOnce(params: {
  url: string;
  auth: OAuthAccess;
  requestIds: LiveRequestIds;
  signal: AbortSignal;
}): Promise<LiveSidebandSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL(params.url);
    if (url.protocol !== "wss:" || url.hostname !== "api.openai.com") {
      reject(new Error("GPT-Live sideband URL is not allowed"));
      return;
    }
    const key = randomBytes(16).toString("base64");
    const req = httpsRequest(url, {
      method: "GET",
      headers: {
        ...liveAuthHeaders(params.auth, params.requestIds),
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
      signal: params.signal,
    });
    const timer = setTimeout(() => req.destroy(new Error("GPT-Live sideband connection timed out")), 15_000);
    timer.unref?.();
    req.once("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(new Error("GPT-Live sideband handshake was invalid"));
        return;
      }
      const sideband = new NodeLiveSidebandSocket(socket);
      if (head.length) socket.unshift(head);
      resolve(sideband);
    });
    req.once("response", (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`GPT-Live sideband rejected the connection (${response.statusCode ?? 0})`));
    });
    req.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live session stopped"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function connectLiveSideband(params: {
  url: string;
  auth: OAuthAccess;
  requestIds: LiveRequestIds;
  signal: AbortSignal;
}): Promise<LiveSidebandSocket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await connectOnce(params);
    } catch (error) {
      lastError = error;
      params.signal.throwIfAborted();
      if (attempt < 4) await wait(200 * 2 ** attempt, params.signal);
    }
  }
  throw lastError;
}

export class EarlyFrameBuffer {
  private frames: string[] = [];
  private bytes = 0;

  push(payload: string): void {
    const size = Buffer.byteLength(payload);
    if (this.frames.length >= MAX_EARLY_FRAMES || this.bytes + size > MAX_EARLY_BYTES) {
      throw new Error("GPT-Live sideband startup buffer exceeded");
    }
    this.frames.push(payload);
    this.bytes += size;
  }

  drain(): string[] {
    const frames = this.frames;
    this.frames = [];
    this.bytes = 0;
    return frames;
  }
}
