import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function normalizeFingerprint(value, label) {
  const fingerprint = typeof value === "string" ? value.trim() : "";
  if (!/^(?:[0-9a-f]{2}:?){32}$/i.test(fingerprint)) {
    throw new Error(`${label} must be a SHA-256 certificate fingerprint.`);
  }
  return fingerprint.replaceAll(":", "").toUpperCase();
}

export function verifyApkSigner({
  expectedFingerprint,
  stdout = "",
  stderr = "",
  status = 0,
}) {
  if (typeof expectedFingerprint !== "string" || !expectedFingerprint.trim()) {
    throw new Error("VF_ANDROID_SIGNING_CERT_SHA256 is required.");
  }
  const expected = normalizeFingerprint(
    expectedFingerprint,
    "VF_ANDROID_SIGNING_CERT_SHA256",
  );
  if (status !== 0) {
    throw new Error("apksigner could not verify the APK.");
  }

  const output = `${stdout}\n${stderr}`;
  if (/Signer #\d+ certificate DN:[^\r\n]*\bAndroid Debug\b/i.test(output)) {
    throw new Error("Debug-signed APKs cannot pass the production signing gate.");
  }

  const signers = [
    ...output.matchAll(
      /Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f:]+)/gi,
    ),
  ];
  if (signers.length !== 1) {
    throw new Error("APK must have exactly one verifiable signer.");
  }

  const actual = normalizeFingerprint(signers[0][1], "APK signer");
  if (actual !== expected) {
    throw new Error("APK signer does not match the pinned production certificate.");
  }

  return actual;
}

function main() {
  const apkPath = process.argv[2];
  if (!apkPath) {
    throw new Error("Usage: node scripts/check-android-apk-signing.mjs <apk-path>");
  }

  const result = spawnSync(
    process.env.APKSIGNER_PATH || "apksigner",
    ["verify", "--print-certs", apkPath],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(`Could not run apksigner: ${result.error.message}`);
  }

  const fingerprint = verifyApkSigner({
    expectedFingerprint: process.env.VF_ANDROID_SIGNING_CERT_SHA256,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  });
  process.stdout.write(
    `APK signer matches the pinned production certificate (${fingerprint}).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`APK signing check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
