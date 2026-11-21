# Android production signing

VillaForge production APKs must be signed with a dedicated release keystore. The
repository intentionally contains no keystore or signing password.

## Create the keystore (once, keep a secure offline backup)

Run locally on a trusted machine. Choose a long unique password and keep it in
a password manager:

```bash
keytool -genkeypair -v \
  -keystore villaforge-release.jks \
  -alias villaforge-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

Do not commit `villaforge-release.jks`, its password, or a base64 copy to Git.
Back up the keystore securely: losing it prevents updates signed with the same
Android application ID from being published under the same signing identity.

## Configure GitHub Actions secrets

In the repository, open **Settings → Secrets and variables → Actions → New
repository secret** and add these four secrets:

| Secret | Value |
|---|---|
| `ANDROID_RELEASE_KEYSTORE_BASE64` | Base64-encoded bytes of `villaforge-release.jks` |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_RELEASE_KEY_ALIAS` | `villaforge-release` (or the alias you selected) |
| `ANDROID_RELEASE_KEY_PASSWORD` | Private-key password |

On Linux, produce the first value without adding line breaks:

```bash
base64 -w0 villaforge-release.jks
```

Paste that output only into the GitHub secret value field. Do not paste it into
an issue, pull request, chat, workflow file, or repository file.

## Build behavior

- Pull-request CI uses the explicit Gradle flag
  `-PallowDebugSigning=true`. Its minified release variant is QA-only and is
  debug-signed; it is not a production release.
- `.github/workflows/build-apk.yml` requires all four secrets and fails closed
  if any is missing. It decodes the keystore into the ephemeral runner temp
  directory with file mode 0600, then signs the production APK with that key.
- The Gradle `assembleRelease` and `bundleRelease` tasks reject missing
  production signing configuration unless the explicit QA-only flag is passed.
- Never add signing secrets to PR workflows from untrusted forks.

After setting the secrets, run **Actions → Build Android APK → Run workflow**
on `main`. Verify the resulting APK signature with Android Build Tools
(`apksigner verify --verbose --print-certs VillaForge.apk`) and retain the
certificate fingerprint for future release verification.
