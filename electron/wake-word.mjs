// Persistent local wake-word lifecycle. Audio stays inside Apple's on-device
// Speech recognizer; this module sees only the final command as NDJSON.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import { buildSpeechHelper, speechHelperBinary, speechHelperBundle } from "./build-speech-helper.mjs";
import { DEFAULT_WAKE_WORD_CONFIG, normalizeWakeWordConfig, parseWakeWordLine } from "./wake-word-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, "resources", "speech-helper.swift");
const INFO = path.join(__dirname, "resources", "speech-helper-Info.plist");
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, "OpenMausBot Speech.app")
  : speechHelperBundle;
const BINARY = app.isPackaged
  ? path.join(BUNDLE, "Contents", "MacOS", "speech-helper")
  : speechHelperBinary;

let targetWindow = null;
let config = DEFAULT_WAKE_WORD_CONFIG;
let listener = null;
let restartTimer = null;
let failures = 0;
const suspensions = new Set();

function configPath() {
  return path.join(app.getPath("userData"), "wake-word.json");
}

function loadConfig() {
  try {
    config = normalizeWakeWordConfig(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch {
    config = DEFAULT_WAKE_WORD_CONFIG;
  }
}

function saveConfig() {
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function ensureBuilt() {
  if (app.isPackaged) return;
  const mtime = existsSync(BINARY) ? statSync(BINARY).mtimeMs : 0;
  if (mtime < Math.max(statSync(SOURCE).mtimeMs, statSync(INFO).mtimeMs)) buildSpeechHelper();
}

function state(extra = {}) {
  return {
    available: process.platform === "darwin",
    enabled: config.enabled,
    listening: Boolean(listener),
    suspended: suspensions.size > 0,
    phrase: config.phrase,
    ...extra,
  };
}

function publish(extra) {
  const snapshot = state(extra);
  if (targetWindow && !targetWindow.isDestroyed()) targetWindow.webContents.send("wake:state", snapshot);
  return snapshot;
}

function clearRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
}

function stopListener() {
  clearRestart();
  if (!listener) return;
  const owned = listener;
  listener = null;
  try {
    writeFileSync(owned.stopPath, "stop");
  } catch {}
  publish();
}

function scheduleRestart() {
  clearRestart();
  if (!config.enabled || suspensions.size || failures >= 3) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startListener();
  }, Math.min(4_000, 500 * 2 ** failures));
  restartTimer.unref?.();
}

function startListener() {
  if (process.platform !== "darwin" || listener || !config.enabled || suspensions.size) {
    publish();
    return;
  }
  try {
    ensureBuilt();
  } catch {
    failures = 3;
    publish({ error: "The local speech helper could not be built." });
    return;
  }

  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "openmausbot-wake-"));
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n", "-g", "-W", "-o", outputPath, "--stderr", errorPath, BUNDLE,
        "--args", "--wake-word", config.phrase, "--endpoint-ms", "1200", "--stop-file", stopPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    failures += 1;
    publish({ error: "The local wake listener could not start." });
    scheduleRestart();
    return;
  }

  const owned = { proc, outputPath, errorPath, stopPath, sessionDir };
  listener = owned;
  let offset = 0;
  let buffer = "";
  let detected = false;
  const drain = () => {
    let content;
    try {
      content = readFileSync(outputPath, "utf8");
    } catch {
      return;
    }
    if (content.length <= offset) return;
    buffer += content.slice(offset);
    offset = content.length;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const command = parseWakeWordLine(line);
      if (!command || listener !== owned) continue;
      detected = true;
      failures = 0;
      suspensions.add("trigger");
      listener = null;
      try { writeFileSync(stopPath, "stop"); } catch {}
      publish();
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.show();
        targetWindow.focus();
        targetWindow.webContents.send("wake:command", command);
      }
    }
  };
  watchFile(outputPath, { interval: 50, persistent: false }, drain);
  publish();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatchFile(outputPath, drain);
    rmSync(sessionDir, { recursive: true, force: true });
  };
  proc.on("close", () => {
    drain();
    cleanup();
    if (listener !== owned) return;
    listener = null;
    if (!detected && !suspensions.size && config.enabled) failures += 1;
    publish(failures >= 3 ? { error: "The wake listener stopped repeatedly. Check microphone and speech access." } : undefined);
    scheduleRestart();
  });
  proc.on("error", () => {
    cleanup();
    if (listener !== owned) return;
    listener = null;
    failures += 1;
    publish({ error: "The local wake listener could not start." });
    scheduleRestart();
  });
}

export function initializeWakeWord(win) {
  targetWindow = win;
  loadConfig();
  win.webContents.once("did-finish-load", () => {
    publish();
    startListener();
  });
  win.once("closed", () => {
    if (targetWindow === win) targetWindow = null;
  });
}

export function getWakeWordState() {
  return state();
}

export function configureWakeWord(patch) {
  config = normalizeWakeWordConfig({ ...config, ...patch });
  failures = 0;
  saveConfig();
  stopListener();
  startListener();
  return state();
}

export function suspendWakeWord(reason) {
  suspensions.add(reason);
  stopListener();
}

export function resumeWakeWord(reason) {
  suspensions.delete(reason);
  if (reason === "call") suspensions.delete("trigger");
  startListener();
}

export function stopWakeWord() {
  suspensions.add("shutdown");
  stopListener();
}
