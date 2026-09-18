import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createFirebaseInvoiceBackend } from "../firebase-backend.mjs";

const require = createRequire(import.meta.url);
const { startServer } = require("../tests/browser-helpers.js");
const port = (name) => {
  const match = process.env[name]?.match(/^127[.]0[.]0[.]1:(\d+)$/);
  if (!match) throw new Error("Prototype fixtures require local Firebase emulators. Run npm run prototype.");
  return Number(match[1]);
};
const emulators = {
  auth: port("FIREBASE_AUTH_EMULATOR_HOST"),
  firestore: port("FIRESTORE_EMULATOR_HOST"),
  storage: port("FIREBASE_STORAGE_EMULATOR_HOST"),
};
const config = { apiKey: "fake-emulator-key", projectId: "demo-ledgerly", appId: "prototype-fixtures", authDomain: "demo-ledgerly.firebaseapp.com", storageBucket: "demo-ledgerly.firebasestorage.app" };
const backup = JSON.parse(await readFile(new URL("../fixtures/prototype-backup.json", import.meta.url), "utf8"));
for (const email of ["demo@example.test", "empty@example.test"]) {
  const backend = createFirebaseInvoiceBackend(config, null, { appName: email, memoryAuth: true, emulators });
  try {
    let session;
    try { session = (await backend.signUp(email, "Demo-password-123!")).session; }
    catch (error) {
      if (error.code !== "auth/email-already-in-use") throw error;
      session = (await backend.signIn(email, "Demo-password-123!")).session;
    }
    if (email.startsWith("demo@")) await backend.migrateLocalData(session.user.id, backup.history, backup.draft, backup.sequences);
  } finally { await backend.close(); }
}
const server = await startServer({ firebase: true, port: Number(process.env.PROTOTYPE_PORT || 55335) });
console.log(`\nFirebase prototype: http://127.0.0.1:${server.address().port}/`);
console.log("Demo login: demo@example.test / Demo-password-123!");
console.log("Empty account: empty@example.test / Demo-password-123!");
console.log("Synthetic local data only. Google login is simulated by the emulator. Ctrl+C stops the prototype.");
await new Promise((resolve) => {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    server.closeAllConnections(); server.close(resolve);
  });
});
