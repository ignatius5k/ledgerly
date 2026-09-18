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

This branch runs verification in GitHub Actions but does not replace main's GitHub Pages site. Publish dist to a separately configured host. For a Firebase Hosting preview, authenticate with Firebase CLI first, then use a preview channel. Configure that host in Firebase Auth authorized domains, Google OAuth JavaScript origins, and Storage CORS before expecting real Google sign-in and cloud PDF downloads to work there. See DEPLOYMENT.md for the existing project's settings.

No new live deployment was made during this verification. A completed real Google login on a physical iPhone/home-screen app remains a manual release check; desktop emulation and the simulated Google chooser do not establish that result.
