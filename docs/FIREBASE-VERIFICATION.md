# Firebase verification — 17–18 September 2026

## Live computer-use evidence

The production-configured local build at `http://localhost:55334/` connects to `ledgerly-e0c95`. This is a local build using the real Firebase project; it is not a deployment to the public website.

- Firebase Console shows Email/Password and Google providers enabled.
- A synthetic account was created through the app’s Create account button. The same account appears in Authentication → Users with the Email provider. Its UID is `vOytoqz8yBdf3FOnA5eJhNxoJtO2`; signing out and signing back in with the same credentials also succeeded.
- Google sign-in completed through the real Google account chooser and returned to the app. Firebase Authentication shows the project account with the Google provider, UID `BCml8dhQjCaF4uLl5jZirJPwQud2`.
- Firestore initially did not exist. The default Standard database was created in `asia-southeast1` (Singapore), with deny-all production rules.
- The private Firestore rules, invoice index exemptions, and Storage rules were published successfully with Firebase CLI in the owner's authorized Cloud Shell. Storage's specific service role for Firestore rule checks was granted. The app then opened its account workspace successfully.
- After the owner completed billing setup, Firebase Console confirms Blaze (Free Trial). The default bucket `ledgerly-e0c95.firebasestorage.app` is in `US-EAST1`; Firestore remains in Singapore. The bucket's GET CORS configuration was applied and read back, matching `storage.cors.json`.
- Through the live app UI, the synthetic account saved `PDF-VERIFY-20260917` for `PDF STORAGE VERIFICATION — TEST ONLY`, amount SGD 1.00. The output dialog confirmed **PDF saved to your account**. After sign-out and sign-in, the invoice appeared in history and **Download PDF** retrieved the stored file successfully.
- Cloud Storage contains `users/vOytoqz8yBdf3FOnA5eJhNxoJtO2/invoices/invoice-0ed9fd2b-f979-4b1d-b55c-a9404831f5fa/revisions/1.pdf`, created at `2026-09-17T12:02:05Z`, content type `application/pdf`, size **183,098 bytes**. The downloaded file has a `%PDF-1.3` header and the same size and base64 MD5 as the cloud object: `1OAsbhTRkAaiXXap9qV//Q==`. Its SHA-256 is `f72f67ef39095d49dd91bb73047ef5745a85be8c882d6c569a4df17956ad1062`.
- An unauthenticated request to the real object's Firebase download endpoint returned HTTP **403**, confirming that the stored test PDF is not anonymously readable without credentials or a sharing token.

The synthetic verification account and test invoice were retained so registration and storage can be inspected. They contain no real customer information. Billing was activated by the owner; no public website deployment was performed during this verification.

## Public GitHub Pages verification — 18 September 2026

The built Firebase app was deployed to `https://ignatius5k.github.io/ledgerly/` through GitHub Actions. The previous repository-root deployment omitted the generated SDK and served a null Firebase configuration. The public app now serves both successfully, and [run 35243617285](https://github.com/ignatius5k/ledgerly/actions/runs/35243617285) passed verification and deployment.

Live computer-use checks on the public URL confirmed:

- Email sign-in with the original verification account loaded `PDF-EQUALITY-20260917`, previously saved through the local production-configured app. This confirms the public site loads the same account's Firebase invoice history.
- Google sign-in completed through Google's real account chooser. The existing Google UID was reused, and the device-data import dialog preserved the browser's existing invoice and draft when **Use account without importing** was selected.
- A new synthetic account was registered from Pages. Firebase Authentication → Users shows its Email provider and UID `qb9dCgBciWhEpP6vaT6khXtIYtD3`.
- The new account saved `PAGES-VERIFY-20260918` for `PAGES STORAGE VERIFICATION — TEST ONLY`, SGD 1.00. The app confirmed **PDF saved to your account**. After sign-out and sign-in, history restored the invoice and downloaded its stored PDF.
- The immediate PDF download and history download after sign-in are both **181,106 bytes**, with identical SHA-256 `e853bbe91cc2409985ae21b7be611ad0c035389b12b621b49b1784fed31282f5`. The rendered PDF is one A4 page with the expected logo, customer, line item, and SGD 1.00 total.
- Firebase Storage contains `users/qb9dCgBciWhEpP6vaT6khXtIYtD3/invoices/invoice-71a6463d-32aa-46d9-8b93-4ec4baa68307/revisions/1.pdf`, shown as `application/pdf`, 176.86 KB. An unauthenticated request to this new object returns HTTP **403**.

The live 842px layout exposed hidden account controls and displaced invoice action columns. The responsive CSS now keeps account identity and Sign out available, aligns table cells to their headers, and preserves mobile invoice cards. Browser regressions check column geometry and actual pointer interaction with Sign out, including correct hiding after sign-out.

## Implemented PDF behavior

Save invoice commits invoice data to Firestore, generates the actual PDF, and uploads it to a private revision-specific Cloud Storage path. The output dialog confirms PDF storage only after upload succeeds. An upload failure leaves the committed invoice data intact and offers retry, local download, and print.

The history Download PDF action retrieves the stored current revision after sign-in, using an authenticated SDK download. Other users and anonymous requests cannot access it. Files are immutable per revision, limited to 10 MiB, and checked against the current invoice; a fingerprint prevents accidental reuse after a deleted ID is recreated with different invoice data.

### Exact PDF consistency follow-up

The immediate **Save as PDF** action and cloud upload use the same generated Blob. If another renderer has already stored a PDF for that revision, the app now loads that existing file and uses its exact bytes for immediate downloads and printing before confirming success. This also preserves PDF metadata, which can differ between separate renderings of identical invoice content. A regression test first reproduced a SHA-256 mismatch in that case, then passed after the fix; it checks immediate and history downloads against the stored original.

The live test invoice was saved again as `PDF-EQUALITY-20260917` (revision 2). Its immediate download and the authenticated history download after reloading the app are both **183,549 bytes**, with SHA-256 `da2a19a97cd84f66c2381c6240513ddf807acc6c461314b114626ec85b052cab`. The PDF was inspected as a single A4 page with the expected invoice layout, logo, amount, and customer text.

## Automated verification

Current local results: **39 automated tests passed** across 19 application/infrastructure tests, 6 Firebase browser scenarios, 8 authentication/Firestore SDK tests, and 6 PDF Storage tests. Production build, production dependency audit, and whitespace checks passed.

The initial GitHub run timed out in the broad application browser scenario. The harness now terminates unfinished HTTP connections when testing offline mode and bounds browser commands with diagnostic errors. Those diagnostics isolated a draft race: Clear saved draft could await an earlier save instead of its newly queued deletion, leaving the editor unchanged. A deterministic regression holds the save, queues deletion, then releases the save. The app now waits for the earlier sync and flushes the deletion before resetting the editor. Regressions also cover held HTTP requests and browser command timeout/disconnect behavior without increasing the overall test timeout.

The Pages deployment check also exposed loss of the latest draft change during immediate reload. A deterministic regression blocks the existing write queue, changes the PDF filename option, and reloads before queued writes can run. Draft staging now records an account-scoped synchronous recovery journal before committing to IndexedDB. Only the matching acknowledged operation can clear it; newer edits remain recoverable.

The checks found and fixed a draft revision race during overlapping sync/sign-out and added session checks that suppress late PDF downloads/print output after an account change.

Two agents independently covered authentication/workspace behavior and PDF persistence. Storage tests use only demo Firebase emulators. Coverage includes exact PDF bytes, private access, immutable retries, MIME/size restrictions, stale revisions, deletion access, restored-ID conflicts, and an actual browser download through the Firebase SDK.

Browser coverage includes email signup/sign-in/sign-out, Google signup and returning users, cancellation and blocked popups, local invoice import, session reload, account isolation, offline draft recovery, real generated PDF upload/download, failed-upload retry, and late-response suppression after sign-out.

See [deployment setup](DEPLOYMENT.md) for activation steps and [operations](OPERATIONS.md) for backup, retention, and recovery behavior.
