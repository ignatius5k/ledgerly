# Firebase prototype verification — 18 September 2026

**Status: automated checks passed; public launch authorized by the user. Deployment pending.**

Branch: `codex/firebase-prototype`, baseline `91b0545`, with local test and CI additions. This round used paired functional comparisons, not a statistical experiment with customers. No production data or deployed permissions were changed.

## Results

49 automated checks: **49 passed, 0 failed, 0 skipped** after investigating the WebKit reload reports.

| Coverage | Result |
| --- | --- |
| Application, draft recovery, offline shell, Google helper and service-worker checks | 24/24 passed |
| Firebase authentication, invoice CRUD, rules, Storage and Chrome browser workflows | 23/23 passed |
| WebKit desktop and iPhone-sized workflows | 2/2 passed; old-document cancellations distinguished from current connection failures |
| Production build | Passed |
| Production dependency audit | 0 vulnerabilities |

The WebKit workflows completed signup, invalid-quantity rejection, invoice creation, cloud PDF storage, download, reload, identical PDF retrieval, sign-out, wrong-password rejection and sign-in. Request tracing proved that the two `due to access control checks` reports refer to the departing document's Firestore session ID. The reloaded document creates a different session and successfully retrieves the same PDF bytes.

The regression test now exempts only errors from previously observed Firestore session IDs, at the configured emulator host, while `page.reload()` is in progress. Errors for new sessions, other URLs, or outside reload still fail. The test also requires a new connection and successful account/PDF recovery. No runtime permissions or application error handling were weakened. This matches a [previously reported Firebase navigation cancellation](https://github.com/firebase/firebase-js-sdk/issues/4527).

## Paired coverage

| Comparison | Verified scope |
| --- | --- |
| Chrome desktop 1440px / mobile 390px | Backup import/export, search/no match, incomplete draft rejection, duplicate cancel/accept, create/edit/delete, PDF download and print-blob preparation |
| Account owner / different account / anonymous | Private invoice and PDF access, denied reads/writes/listing across accounts |
| Valid / invalid authentication | Email signup, login/logout, password reset; simulated Google cancellation/import/relogin |
| Online / offline and reload | Queued drafts, recovery, account isolation, concurrent and stale revisions |
| Successful / failed PDF upload | Honest status, retry of identical bytes, immutable revisions and history retrieval |
| Valid / invalid records | Five-line invoices, malformed data, revision bypass, stale PDF and size checks |
| Correct / ahead device clock | New invoice and update with clock five minutes ahead |
| Saved / deleted invoices | Deletion revokes PDF access; reused invoice IDs do not reuse stale PDF contents |
| Current / updated offline shell | Cache boundaries, offline shell, explicit service-worker update activation |

Print coverage verifies generated PDF preparation; it does not operate a physical printer. WebKit iPhone emulation is not a physical iPhone. Live Google OAuth completion, home-screen installation and native print sheets still require manual device verification. The production customer account was not exercised in this round.

## Review the local app

Open **http://127.0.0.1:55335/** on this Mac.

- Populated synthetic account: `demo@example.test`
- Empty synthetic account: `empty@example.test`
- Password for either: `Demo-password-123!`

This is the Firebase emulator prototype. Google selection is simulated; use the synthetic accounts for review. The existing review server and its data were preserved.

Suggested acceptance checks:

- [ ] Open the rental, discount, five-line and Unicode fixtures; verify totals and layout.
- [ ] Create, edit and duplicate an invoice; verify the original remains unchanged.
- [ ] Download a PDF, reload, and download it again from history.
- [ ] Search invoices; export a backup and inspect it.
- [ ] Switch between the two accounts and confirm their records stay separate.
- [ ] Review at narrow mobile width, including PDF actions and validation.
- [x] Trace the WebKit reload reports and verify the replacement connection.
- [ ] Complete live Google login and native PDF/print checks on a physical iPhone before launch sign-off.

The user subsequently authorized public launch. Physical-device testing remains a stated coverage limitation, not a claim of verification.

## Reproduce and inspect

- `npm test` — 24 checks.
- `npm run test:firebase` — 23 checks including the new desktop/mobile matrix.
- `npx playwright-core install webkit`, then `npm run test:webkit` — 2 WebKit checks.
- `npm run build`
- `npm audit --omit=dev --audit-level=high`

The usual emulator scripts share ports with the review app; stop it before running those scripts. This round instead used isolated ports 20099/28080/29199 with `tmp/verification-round2/firebase.json`, preserving the review app.

Local evidence:

- `/tmp/ledgerly-round2-app.log`
- `/tmp/ledgerly-round2-final-firebase.log`
- `/tmp/ledgerly-round2-webkit-diagnostic.log` (original reproduction)
- `/tmp/ledgerly-webkit-trace.log` (old/new session tracing)
- `/tmp/ledgerly-webkit-release.log` (2/2 passed)
- `/tmp/ledgerly-round2-build.log`
- `/tmp/ledgerly-round2-audit.log`
- `tmp/verification-round2/screenshots/`

Screenshots taken immediately after reload may catch the startup fade; automated assertions separately checked the resulting invoice and downloaded PDF. Temporary evidence is local and may be cleaned by the operating system.
