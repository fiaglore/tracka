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

## Signing

Release builds are signed with the AnchorTrakk release key (RSA 4096, alias `anchortrakk`,
valid to 2056). The key and its passwords live in four GitHub secrets
(`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`) and in the owner's private backup. They are **not** in this repo.
Its public fingerprint is in `.well-known/assetlinks.json`, which is what lets Chrome run
the app full-screen with no browser bar.

- Publishing (the **Publish** tick box) is refused unless the real key is present and its
  fingerprint is listed in `assetlinks.json`.
- Without the secrets, normal builds still work but use a throwaway debug key (browser bar
  shows, and such an APK cannot be updated over a release-signed one).
- **Never lose the key.** Without it nobody can update the app for people who already
  installed the APK. Keep `anchortrakk-release.jks` and its passwords in a password manager.
- Switching key (only if it is lost or leaked): create a new one, update the four secrets
  and the fingerprint in `assetlinks.json`; people on the old key must uninstall and
  reinstall.

If you ever need to make a key again:
```bash
keytool -genkeypair -v -storetype PKCS12 -keystore anchortrakk-release.jks -alias anchortrakk \
  -keyalg RSA -keysize 4096 -validity 10950
base64 -w0 anchortrakk-release.jks   # Mac: base64 -i anchortrakk-release.jks
```

## Google Play

Upload `AnchorTrakk.aab`. Play re-signs the app with its own key, so also add the
**App signing key SHA-256** shown in Play Console (Setup → App signing) to
`assetlinks.json`; keep both fingerprints in the list. If you sell Premium inside the
Play app, Google's billing rules apply (see PAY-09 in the dossier).

## Changing the app

- Start page / colours: `app/src/main/AndroidManifest.xml`, `res/values/colors.xml`.
- Package name `ng.com.anchortrakk.twa` must match `.well-known/assetlinks.json`.
- Version: set automatically from the workflow run number.
