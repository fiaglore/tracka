# AnchorTrakk Android app

A **Trusted Web Activity** (TWA): a thin Android shell that opens
https://www.anchortrakk.com.ng/sign-in.html full-screen in Chrome. There is no second
copy of the app: every website update shows up in the Android app straight away, and
sign-in, offline mode and notifications work exactly as on the web.

## Build

Builds run on GitHub (Actions → "Android app"). Push anything under `android/`, or run
it by hand. The result is the `AnchorTrakk-android` artifact:

- `AnchorTrakk.apk`: installs directly on a phone.
- `AnchorTrakk.aab`: the file Google Play wants.

Tick **Publish** when running it by hand to attach both files to a GitHub release;
the website's download button points at the latest release's `AnchorTrakk.apk`.

## Signing (do this once, before sharing the app widely)

Without a signing key the build uses a throwaway debug key. The app still works, but
Chrome cannot verify it owns the website, so a browser address bar shows at the top.
To get the true full-screen app:

1. Create a key (keep the file and passwords somewhere safe; **losing it means you
   can never update the app on Play**, and never commit it):
   ```bash
   keytool -genkeypair -v -keystore anchortrakk-release.jks -alias anchortrakk \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Base64-encode it: `base64 -w0 anchortrakk-release.jks` (on a Mac: `base64 -i anchortrakk-release.jks`).
3. In GitHub → Settings → Secrets and variables → Actions, add:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
   (`anchortrakk`), `ANDROID_KEY_PASSWORD`.
4. Run the workflow. Its log prints the **SHA-256 certificate fingerprint**. Put it in
   `.well-known/assetlinks.json` (`sha256_cert_fingerprints`) and deploy the site.

## Google Play

Upload `AnchorTrakk.aab`. Play re-signs the app with its own key, so also add the
**App signing key SHA-256** shown in Play Console (Setup → App signing) to
`assetlinks.json`; keep both fingerprints in the list. If you sell Premium inside the
Play app, Google's billing rules apply (see PAY-09 in the dossier).

## Changing the app

- Start page / colours: `app/src/main/AndroidManifest.xml`, `res/values/colors.xml`.
- Package name `ng.com.anchortrakk.twa` must match `.well-known/assetlinks.json`.
- Version: set automatically from the workflow run number.
