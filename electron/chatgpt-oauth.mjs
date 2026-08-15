import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, ipcMain, safeStorage, shell } from "electron";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const PROFILE_FILE = "chatgpt-oauth.enc";
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

function accountIdentity(accessToken) {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("ChatGPT returned an invalid access token");
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new Error("ChatGPT returned an invalid access token payload"); }
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("ChatGPT token is missing an account id");
  const jwtExpiry = typeof payload.exp === "number" ? payload.exp * 1_000 : undefined;
  return { accountId: accountId.trim(), jwtExpiry };
}

async function tokenRequest(fields, signal) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_TOKEN_RESPONSE_BYTES) throw new Error("ChatGPT OAuth response is too large");
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = {}; }
  if (!response.ok) throw new Error(`ChatGPT OAuth failed (${response.status})`);
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error("ChatGPT OAuth response is missing tokens");
  }
  const identity = accountIdentity(body.access_token);
  const expiresAt = identity.jwtExpiry ?? Date.now() + Math.max(60, Number(body.expires_in) || 3_600) * 1_000;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accountId: identity.accountId,
    expiresAt,
  };
}

function html(message, ok) {
  const color = ok ? "#56d364" : "#f85149";
  return `<!doctype html><meta charset="utf-8"><title>OpenMausBot</title><body style="background:#070707;color:#fff;font:16px -apple-system;padding:48px"><h2 style="color:${color}">${message}</h2><p>You can close this window and return to OpenMausBot.</p></body>`;
}

export class ChatGptOAuthManager {
  constructor() {
    this.profilePath = path.join(app.getPath("userData"), PROFILE_FILE);
    this.login = null;
  }

  status() {
    try {
      const profile = this.readProfile();
      return { authenticated: Boolean(profile?.refreshToken), account: "ChatGPT", model: "gpt-live-1-codex" };
    } catch (error) {
      return { authenticated: false, account: "ChatGPT", model: "gpt-live-1-codex", error: error.message };
    }
  }

  async connect() {
    if (this.login) return this.login;
    this.login = this.runLogin().finally(() => { this.login = null; });
    return this.login;
  }

  disconnect() {
    try { fs.unlinkSync(this.profilePath); } catch {}
    return this.status();
  }

  async resolveAccess() {
    let profile = this.readProfile();
    if (!profile?.refreshToken) throw new Error("Connect ChatGPT in Voice settings first");
    if (!profile.accessToken || profile.expiresAt <= Date.now() + 60_000) {
      profile = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: profile.refreshToken,
        client_id: CLIENT_ID,
      });
      this.writeProfile(profile);
    }
    const identity = accountIdentity(profile.accessToken);
    if (identity.accountId !== profile.accountId) throw new Error("ChatGPT account changed during refresh");
    return { accessToken: profile.accessToken, accountId: profile.accountId };
  }

  readProfile() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable");
    let encrypted;
    try { encrypted = fs.readFileSync(this.profilePath); } catch { return null; }
    const profile = JSON.parse(safeStorage.decryptString(encrypted));
    return profile && typeof profile === "object" ? profile : null;
  }

  writeProfile(profile) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable");
    fs.mkdirSync(path.dirname(this.profilePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(profile));
    const temporary = `${this.profilePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, this.profilePath);
    fs.chmodSync(this.profilePath, 0o600);
  }

  async runLogin() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    const authorize = new URL(AUTHORIZE_URL);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      // Match the official OpenAI Codex subscription authorization profile.
      // A custom originator can yield a valid token that is nevertheless
      // denied by the Codex V3 voice-session endpoint.
      originator: "pi",
    })) authorize.searchParams.set(key, value);

    const controller = new AbortController();
    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8", connection: "close" });
          res.end(html("Authentication rejected.", false));
          return;
        }
        const value = url.searchParams.get("code");
        if (!value) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8", connection: "close" });
          res.end(html("Missing authorization code.", false));
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
        res.end(html("ChatGPT connected.", true));
        resolve(value);
        server.closeAllConnections();
        server.close();
      });
      const timer = setTimeout(() => {
        controller.abort();
        server.close();
        reject(new Error("ChatGPT login timed out"));
      }, LOGIN_TIMEOUT_MS);
      timer.unref?.();
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.listen(1455, "localhost", async () => {
        try { await shell.openExternal(authorize.toString()); }
        catch (error) { clearTimeout(timer); server.close(); reject(error); }
      });
      server.once("close", () => clearTimeout(timer));
    });
    const profile = await tokenRequest({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }, controller.signal);
    this.writeProfile(profile);
    return this.status();
  }
}

export function registerChatGptOAuthIpc(manager) {
  ipcMain.handle("chatgpt-oauth:status", () => manager.status());
  ipcMain.handle("chatgpt-oauth:connect", () => manager.connect());
  ipcMain.handle("chatgpt-oauth:disconnect", () => manager.disconnect());
}

export function attachChatGptOAuthBroker(proc, manager) {
  proc.on("message", async (message) => {
    if (message?.type !== "openmaus:oauth-request" || typeof message.requestId !== "string") return;
    try {
      const access = await manager.resolveAccess();
      proc.postMessage({ type: "openmaus:oauth-response", requestId: message.requestId, ok: true, ...access });
    } catch (error) {
      proc.postMessage({
        type: "openmaus:oauth-response",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 300) : "ChatGPT OAuth failed",
      });
    }
  });
}
