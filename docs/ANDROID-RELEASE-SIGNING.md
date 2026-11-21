# Android Release Signing

The normal **Build APK** workflow creates a Debug APK for development checks. Its application ID is suffixed with `.debug`, so it can be installed beside the production app without replacing it. It is not the distributable signed Release package.

The **Build signed Android Release** workflow creates `app-release.apk`, verifies its Android signature and production certificate fingerprint with `apksigner`, then publishes the APK and SHA-256 checksum as a workflow artifact.

## Required protected environment

Before adding any signing material:

1. Protect the `main` branch. Require pull requests, required status checks, and an independent review; disallow direct pushes and force pushes.
2. Create a GitHub Actions environment named `android-release`.
3. Restrict that environment's deployment branches to `main` only.
4. Configure required deployment reviewers and prevent self-review where the repository plan supports those controls.
5. Remove any repository-level copies of the signing secrets. Store them only as **environment secrets** in `android-release`, so the signing workflow cannot fall back to unprotected repository secrets.

GitHub may auto-create an environment the first time a workflow references it. Do not rely on that default-created environment: configure its branch restriction and approval protection before adding its secrets.

## Required environment secrets and variable

Configure these **environment secrets** in `android-release`:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded existing Android signing keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Alias of the app-signing key in the keystore |
| `ANDROID_KEY_PASSWORD` | Password for that key |

Also configure this **environment variable**:

| Variable | Value |
|---|---|
| `ANDROID_EXPECTED_CERT_SHA256` | 64-character SHA-256 fingerprint of the certificate on the currently distributed production APK |

Use the fingerprint from a trusted copy of the currently distributed app, not from the newly built candidate. The workflow rejects a missing or mismatching fingerprint and intentionally requires exactly one signer certificate.

Do not put keystore files, passwords, or private signing material in the repository, workflow YAML, logs, artifacts, or issue/PR comments. The certificate fingerprint is public verification data; the keystore and passwords are private signing material.

## Important signing continuity rule

Use the existing signing key that owns the currently distributed Android application. Do not generate a new key merely to make this workflow pass: a different signing certificate can prevent updates from installing over existing copies or being accepted by the app distribution channel.

If the current signing keystore is unavailable, stop and recover the original key or confirm the app's signing arrangement before proceeding. If the app uses a store-managed signing key or multiple signers, verify the real installation/update signing arrangement before selecting the expected certificate; do not guess the fingerprint.

## Trusted-source rule

The signed Release workflow accepts manual dispatch **from `main` only** and checks out the exact immutable commit SHA that triggered the run. Dispatching it from a feature branch or pull-request branch skips the signing job. There is deliberately no free-form branch/tag input.

Therefore, run the signed Release workflow only after the reviewed change has been merged to protected `main` and the desired source commit is present there. Build and test untrusted PR code without signing secrets; never expose the production keystore to arbitrary branch code or a PR's Gradle scripts.

The four signing secrets are read only by the protected environment job. The workflow checks the APK signature, package ID, required notification permissions, expected production certificate, and SHA-256 checksum before uploading the artifact.

## Android version metadata

Before Gradle runs, `scripts/configure-android-version.py` checks that the versions in `package.json`, `index.html` (`APP_VERSION`), and `sw.js` (`CACHE_NAME`) match exactly.

It then writes the matching version to the generated Capacitor Android Gradle project. The `versionCode` rule is:

`major × 1,000,000 + minor × 1,000 + patch`

For example, `2.9.1` becomes `versionCode 2009001`.

The workflow does not change application version numbers. Update all source version declarations together only when the release candidate is frozen and approved.

## Run

After merging the reviewed and manually tested source to `main`, open **Actions → Build signed Android Release → Run workflow** and run it against `main`. Approve the `android-release` environment deployment when GitHub requests the required review.

The workflow fails before building if the four signing secrets are missing, the keystore cannot be opened with the supplied alias and password, or the resulting APK does not match the pinned production certificate.
