import assert from "node:assert/strict";
import test from "node:test";
import { verifyApkSigner } from "./check-android-apk-signing.mjs";

const fingerprint = "A".repeat(64);
const digest = fingerprint.match(/.{2}/g).join(":");
const signerOutput = (dn = "CN=VillaForge Production") =>
  `Signer #1 certificate DN: ${dn}\nSigner #1 certificate SHA-256 digest: ${digest}\n`;

test("requires an expected production certificate fingerprint", () => {
  assert.throws(
    () => verifyApkSigner({ expectedFingerprint: "", stdout: signerOutput() }),
    /VF_ANDROID_SIGNING_CERT_SHA256 is required/,
  );
});

test("rejects a debug signer even if its digest is pinned", () => {
  assert.throws(
    () =>
      verifyApkSigner({
        expectedFingerprint: fingerprint,
        stdout: signerOutput("CN=Android Debug, O=Android, C=US"),
      }),
    /Debug-signed APKs cannot pass/,
  );
});

test("rejects a signer whose fingerprint does not match the pin", () => {
  assert.throws(
    () =>
      verifyApkSigner({
        expectedFingerprint: "B".repeat(64),
        stdout: signerOutput(),
      }),
    /does not match the pinned production certificate/,
  );
});

test("accepts an exact pinned production signer match", () => {
  assert.equal(
    verifyApkSigner({
      expectedFingerprint: fingerprint.match(/.{2}/g).join(":"),
      stdout: signerOutput(),
    }),
    fingerprint,
  );
});
