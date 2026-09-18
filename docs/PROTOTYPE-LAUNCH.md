# Firebase prototype launch

This version lives on `codex/firebase-prototype`, independently of the device-only main branch. The timestamp fix uses server time for new invoices, preventing a fast computer clock from causing permission errors. Historical import dates remain supported. Security rules have not been weakened.

## Run the sample workspace

Requires Node 24, npm 11, Java 21 or newer, and Chrome for browser tests.

```sh
npm ci
npm run prototype
```

Open http://127.0.0.1:55335/. This is a local emulator demo, not the live customer database.

| Account | Password | Starting data |
| --- | --- | --- |
| demo@example.test | Demo-password-123! | Four invoices and an unfinished draft |
| empty@example.test | Demo-password-123! | Empty, separate account |

The fixture file is `fixtures/prototype-backup.json`: rental, discount, five-line invoice, Unicode customer/text, and incomplete draft. Open a saved invoice and choose Save invoice to generate and store its real PDF. Google login uses Firebase's simulated account chooser here. Demo data resets when the emulator session ends. Never use these demo credentials in a live project.

The prototype uses dedicated ports 19099 (Auth), 18080 (Firestore), 19199 (Storage), and 55335 (web), so it can coexist with the original development environment. Stop the prototype before running the Firebase test suite, which uses the same dedicated emulator ports. Set PROTOTYPE_PORT if the web port is occupied.

## Verification, 18 September 2026

All 45 automated tests passed: 24 application/infrastructure tests and 21 Firebase/browser/storage tests. Production build and production dependency audit passed, with zero reported vulnerabilities. Browser tests require Chrome and completed without skips.

Coverage includes mobile signup and invoice saving at 390px, responsive layouts down to 320px, email login/logout, password reset, Google popup cancellation/blocking/returning users, local invoice import, session reload, private account isolation, offline draft recovery, concurrent edits, exact PDF upload/download bytes, failed upload retry, deletion access revocation, and a computer clock five minutes ahead.

```sh
npm test
npm run test:firebase
npm run build
npm audit --omit=dev --audit-level=high
```

## Build against the real Firebase account

Use `firebase-config.local.json` or FIREBASE_WEB_CONFIG with the project's public web configuration, then run `npm run build`. The resulting `dist/` is deployable. The demo runner always supplies its own emulator configuration and never seeds the live project.

## Public launch

The Firebase prototype was publicly deployed with user authorization on 18 September 2026:

- URL: https://ignatius5k.github.io/ledgerly/
- Released commit: `68818753263aba4eeffdb3810f459ca2467c1855`
- Cache version: v63, distinct from the device-only main build.
- All 49 automated checks passed in [the deployment run](https://github.com/ignatius5k/ledgerly/actions/runs/35323802418).
- Existing account history and authenticated PDF download were verified on the public site.

To intentionally release a verified prototype revision, dispatch `ci.yml` on `codex/firebase-prototype`. Ordinary pushes to that branch verify only. The workflow builds with the existing `FIREBASE_WEB_CONFIG` repository secret and deploys only after the checks pass.

Main remains a separate device-only branch. Its existing push deployment can replace the same Pages URL; coordinate future main releases accordingly. No main-branch source was changed for this launch.

GitHub Pages uses the existing hosting arrangement. No paid hosting service was added. Existing Firebase usage/billing still applies. Physical iPhone Google sign-in and native print-sheet testing remain manual coverage limitations; WebKit iPhone emulation passed.

See [the full verification report](VERIFICATION-ROUND2.md).
