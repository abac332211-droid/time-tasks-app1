# Android Release Signing

The normal **Build APK** workflow creates a Debug APK for development checks. Its application ID is suffixed with `.debug`, so it can be installed beside the production app without replacing it. It is not the distributable signed Release package.

The manual **Build signed Android Release** workflow creates `app-release.apk`, verifies its signature with Android `apksigner`, and publishes the APK and SHA-256 checksum as a workflow artifact.

## Required GitHub Actions secrets

Configure these repository secrets before running the Release workflow:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded existing Android signing keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Alias of the app-signing key in the keystore |
| `ANDROID_KEY_PASSWORD` | Password for that key |

Do not put keystore files, passwords, or private signing material in the repository, workflow YAML, logs, or issue/PR comments.

## Important signing continuity rule

Use the existing signing key that owns the currently distributed Android application. Do not generate a new key merely to make this workflow pass: a different signing certificate can prevent updates from installing over existing copies or being accepted by the app distribution channel.

If the current signing keystore is unavailable, stop and recover the original key or confirm the app's signing arrangement before proceeding.

## Android version metadata

Before Gradle runs, `scripts/configure-android-version.py` checks that the versions in `package.json`, `index.html` (`APP_VERSION`), and `sw.js` (`CACHE_NAME`) match exactly.

It then writes the matching version to the generated Capacitor Android Gradle project. The `versionCode` rule is:

`major × 1,000,000 + minor × 1,000 + patch`

For example, `2.9.1` becomes `versionCode 2009001`.

The workflow does not change application version numbers. Update all source version declarations together only when the release candidate is frozen and approved.

## Run

Open **Actions → Build signed Android Release → Run workflow** and select the reviewed branch or tag. The default is `codex/v2.9.1-stability`.

The workflow fails before building if the four signing secrets are missing or the keystore cannot be opened with the supplied alias and password.
