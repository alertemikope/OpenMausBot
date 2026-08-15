// Build the native recognizer as a real app bundle. macOS privacy enforcement
// does not accept a purpose string embedded in a loose command-line binary on
// current releases; TCC reads the Info.plist belonging to the executable's
// bundle and terminates the process before Swift can recover when it is absent.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");
const signingIdentity = process.env.OPENMAUSBOT_CODESIGN_IDENTITY?.trim()
  || "OpenMausBot Local Development";

export const speechHelperBundle = path.join(resourcesDir, "OpenMausBot Speech.app");
export const speechHelperBinary = path.join(speechHelperBundle, "Contents", "MacOS", "speech-helper");

export function buildSpeechHelper() {
  const contents = path.join(speechHelperBundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "speech-helper-Info.plist"), path.join(contents, "Info.plist"));
  execFileSync(
    "swiftc",
    ["-O", path.join(resourcesDir, "speech-helper.swift"), "-o", speechHelperBinary],
    { stdio: "inherit", timeout: 120_000 },
  );
  // Sign with the same certificate-backed identity as the containing app.
  // An ad-hoc signature is tied to the binary's CDHash, so rebuilding this
  // helper would otherwise make macOS ask for Microphone and Speech again.
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      signingIdentity,
      "--options",
      "runtime",
      "--entitlements",
      path.join(projectDir, "build", "entitlements.mac.plist"),
      speechHelperBundle,
    ],
    { stdio: "inherit", timeout: 30_000 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSpeechHelper();
}
