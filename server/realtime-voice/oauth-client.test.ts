import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { ElectronOAuthClient } from "./oauth-client.ts";

class FakePort extends EventEmitter {
  sent: unknown[] = [];
  postMessage(message: unknown) { this.sent.push(message); }
}

describe("Electron OAuth broker client", () => {
  it("returns the secret only inside the utility-process channel", async () => {
    const port = new FakePort();
    const client = new ElectronOAuthClient(port, 1_000);
    const pending = client.resolveAccess();
    const request = port.sent[0] as { requestId: string };
    port.emit("message", {
      type: "openmaus:oauth-response",
      requestId: request.requestId,
      ok: true,
      accessToken: "secret",
      accountId: "acct",
    });
    await expect(pending).resolves.toEqual({ accessToken: "secret", accountId: "acct" });
  });

  it("times out without falling back to a paid API key", async () => {
    const port = new FakePort();
    await expect(new ElectronOAuthClient(port, 5).resolveAccess()).rejects.toThrow(/timed out/i);
  });
});
