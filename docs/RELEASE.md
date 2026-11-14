# Fork release runbook (`0.6.4-own.N`)

This fork publishes trial APKs from its own GitHub releases so the Android updater
(`apps/android/src/services/app-update.ts`) can find them. Upstream npm releases are
unaffected.

## 1. Prepare

1. Confirm `github.com/luiluilao/…` network access (on this PC a proxy is required;
   GitHub is unreachable directly). Set `git -c http.proxy=… -c https.proxy=…` and
   `$env:HTTP_PROXY` / `$env:HTTPS_PROXY` for `gh`.
2. Bump `apps/android/app.json`: `version` → `0.6.4-own.N`, `android.versionCode` +1,
   `ios.buildNumber` +1; bump `apps/android/package.json` `version` to match.
3. Update `docs/CHANGELOG.md` (user-facing notes only) and any handoff notes.
4. `git status` must be clean; commits land on `feat/ux-fixes`.

## 2. Build the APK

The build runs from a clean worktree pinned to the release commit, so untracked local
state cannot leak into the artifact:

```powershell
# copied from artifacts/android-build/ux-logs/build-ownN.ps1
git worktree add <root>\dsh-remote-ownN <commit>
# worktree: pnpm install (NODE_ENV unset), packages build, renderers, tsc,
# expo prebuild, trial patches, gradle assembleRelease arm64-v8a
```

Expected: `BUILD SUCCESSFUL in ~4–5 min`, APK ≈ 62–66 MB, `versionCode` matches
`app.json`. Record bytes + SHA-256 next to the APK
(`artifacts/android-build/apk/METADATA-0.6.4-ownN.txt`).

## 3. Tag, push, publish

```powershell
git tag -a v0.6.4-own.N -m "0.6.4-own.N"
git push origin feat/ux-fixes
git push origin v0.6.4-own.N
gh release create v0.6.4-own.N "<apk>" `
  --title "0.6.4-own.N — <summary>" `
  --notes-file artifacts/RELEASE-NOTES-v0.6.4-own.N.md
```

The APK **must** be an asset of the release: the in-app updater resolves
`releases/latest` → APK asset → mirrors (gh-proxy / ghfast) before downloading.

## 4. Host plugin (optional in the same batch)

The Android side only sees `app-api.v1` when the Host plugin is rebuilt. Never commit
`packages/plugin/dist`; build and pack locally instead:

```powershell
$env:NODE_ENV = 'production'
pnpm --filter ds-harness-remote build
node scripts/verify-dsh-plugin.mjs
pnpm --filter ds-harness-remote pack --pack-destination <artifacts>\plugin-release
git checkout -- packages/plugin/dist/index.js packages/plugin/dist/client.github.js
```

Install into the running profile (backup first, then restart DSH):

```powershell
Copy-Item ~\.dsh\profiles\desktop\node_modules\ds-harness-remote <backup> -Recurse
# expand the tarball over that directory, keep package.json/bin/dist/dist as shipped
```

Restarting DSH drops active sessions — ask the user first.

## 5. Verify

- Android: settings show the new version; `releases/latest` resolves; installing the
  APK over the previous build keeps data and bumps `versionCode`.
- Host: `harness.transport.describe` advertises `app-api.v1`; the composer shows the
  microphone entry on Harness sessions.
- Real-device pass: voice input, read aloud (play/stop), image text extraction,
  link summary, web search (only when `DSH_REMOTE_SEARCH_KEY` is set), dark mode.

## 6. Rollback

Delete the release/tag and re-point `releases/latest` by publishing a newer patch
(`-own.N.1`); the updater orders `own.N.M` patch builds, and `versionCode` must keep
increasing for Android installs.
