import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { createFirebaseInvoiceBackend } from "../firebase-backend.mjs";

const projectId = "demo-ledgerly";
function emulatorPort(name) {
  const match = process.env[name]?.match(/^(?:localhost|127[.]0[.]0[.]1):(\d+)$/);
  if (!match) throw new Error(`${name} must identify a local emulator. These tests must never contact production.`);
  return Number(match[1]);
}
const ports = {
  auth: emulatorPort("FIREBASE_AUTH_EMULATOR_HOST"),
  firestore: emulatorPort("FIRESTORE_EMULATOR_HOST"),
};
const invoice = (billTo = "TEST CUSTOMER") => ({
  invoiceNumber: "EHR-20260912-001", invoiceDate: "2026-09-12", dueDate: "2026-09-19",
  pdfFileName: "test-invoice", pdfFileNameCustomized: true, billTo,
  items: [{ id: "item-1", quantity: 1, description: "Emulator test only", price: 120 }],
});
let rules;
let alice;
let bob;
let otherDevice;
let aliceId;
let bobId;
const clients = [];
function client(name) {
  const backend = createFirebaseInvoiceBackend({ apiKey: "fake-emulator-key", projectId, appId: `test-${name}`, authDomain: `${projectId}.firebaseapp.com` }, null, {
    appName: name, memoryAuth: true, emulators: ports,
  });
  clients.push(backend);
  return backend;
}

before(async () => {
  rules = await initializeTestEnvironment({ projectId, firestore: {
    host: "127.0.0.1", port: ports.firestore, rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
  } });
  await rules.clearFirestore();
  await fetch(`http://127.0.0.1:${ports.auth}/emulator/v1/projects/${projectId}/accounts`, { method: "DELETE" });
  alice = client("alice"); bob = client("bob"); otherDevice = client("alice-other-device");
});
after(async () => { await Promise.all(clients.map((backend) => backend.close())); await rules?.cleanup(); });

test("email sign-up, sign-in, sign-out, and private account sessions", async () => {
  assert.equal(await alice.getSession(), null);
  aliceId = (await alice.signUp("alice@example.test", "Test-password-123!")).session.user.id;
  bobId = (await bob.signUp("bob@example.test", "Test-password-123!")).session.user.id;
  assert.notEqual(aliceId, bobId);
  await otherDevice.signIn("alice@example.test", "Test-password-123!");
  assert.equal((await otherDevice.getSession()).user.id, aliceId);
  await assert.rejects(otherDevice.signIn("alice@example.test", "wrong-password"));
  await otherDevice.signOut();
  assert.equal(await otherDevice.getSession(), null);
  await otherDevice.signIn("alice@example.test", "Test-password-123!");
});

test("cloud invoice CRUD survives a new device and rejects concurrent/stale writes", async () => {
  const saved = await alice.saveInvoice(aliceId, { id: "invoice-1", invoice: invoice() });
  assert.equal(saved.revision, 1);
  const remote = (await otherDevice.listInvoices(aliceId)).records[0];
  assert.equal(remote.id, saved.id);
  assert.equal(remote.invoice.billTo, "TEST CUSTOMER");
  const writes = await Promise.allSettled([
    alice.saveInvoice(aliceId, { ...remote, invoice: invoice("DEVICE A") }),
    otherDevice.saveInvoice(aliceId, { ...remote, invoice: invoice("DEVICE B") }),
  ]);
  assert.equal(writes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(writes.find((entry) => entry.status === "rejected").reason.code, "INVOICE_REVISION_CONFLICT");
  const latest = (await alice.listInvoices(aliceId)).records[0];
  assert.equal(latest.revision, 2);
  await assert.rejects(alice.deleteInvoice(aliceId, latest.id, 1), { code: "INVOICE_REVISION_CONFLICT" });
  assert.equal(await alice.deleteInvoice(aliceId, latest.id, 2), true);
  await assert.rejects(otherDevice.saveInvoice(aliceId, latest), { code: "INVOICE_REVISION_CONFLICT" });
  assert.equal((await otherDevice.listInvoices(aliceId)).total, 0);
});

test("Firestore rules deny anonymous, cross-account, malformed, and revision-bypassing requests", async () => {
  await alice.saveInvoice(aliceId, { id: "private-invoice", invoice: invoice("ALICE PRIVATE") });
  assert.equal((await bob.listInvoices(bobId)).total, 0);
  await assert.rejects(bob.listInvoices(aliceId), { code: "auth/user-token-expired" });
  const outsider = rules.authenticatedContext(bobId).firestore();
  const anonymous = rules.unauthenticatedContext().firestore();
  const owner = rules.authenticatedContext(aliceId).firestore();
  for (const database of [outsider, anonymous]) {
    const path = doc(database, "users", aliceId, "invoices", "private-invoice");
    await assertFails(getDoc(path));
    await assertFails(getDocs(collection(database, "users", aliceId, "invoices")));
    await assertFails(setDoc(path, { id: "private-invoice" }));
    await assertFails(deleteDoc(path));
    await assertFails(getDoc(doc(database, "users", aliceId, "drafts", "current")));
    await assertFails(getDoc(doc(database, "users", aliceId, "sequences", "20260912")));
  }
  const ownInvoice = doc(owner, "users", aliceId, "invoices", "private-invoice");
  await assertSucceeds(getDoc(ownInvoice));
  await assertFails(updateDoc(ownInvoice, { revision: 8, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ownInvoice, { revision: 2, invoice: { ...invoice(), historyId: "private-invoice", draftDirty: false, billTo: "x".repeat(2001) }, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(owner, "users", bobId), { administrator: true }));
  await assertFails(setDoc(doc(owner, "users", aliceId, "sequences", "20260912"), { sequence: 0 }));
});

test("draft revisions protect offline changes and stay monotonic after deletion", async () => {
  const draft = { ...invoice(), billTo: "", items: [{ id: "in-progress", quantity: "", description: "", price: "" }] };
  assert.equal((await alice.saveDraft(aliceId, draft)).revision, 1);
  assert.equal((await otherDevice.loadDraft(aliceId)).revision, 1);
  assert.equal((await alice.saveDraft(aliceId, invoice("NEW DRAFT"), undefined, 1)).revision, 2);
  await assert.rejects(otherDevice.saveDraft(aliceId, draft, undefined, 1), { code: "DRAFT_REVISION_CONFLICT" });
  await assert.rejects(otherDevice.deleteDraft(aliceId, undefined, 1), { code: "DRAFT_REVISION_CONFLICT" });
  await alice.deleteDraft(aliceId, undefined, 2);
  assert.equal(await alice.loadDraft(aliceId), null);
  assert.equal((await alice.saveDraft(aliceId, draft)).revision, 4);
  await assert.rejects(otherDevice.saveDraft(aliceId, draft, undefined, 2), { code: "DRAFT_REVISION_CONFLICT" });
  assert.equal(await bob.loadDraft(bobId), null);
  await alice.deleteDraft(aliceId, undefined, 4);
});

test("the rules accept full five-line invoices and their updates", async () => {
  const value = invoice("FIVE LINES");
  value.items = Array.from({ length: 5 }, (_, i) => ({ id: `five-${i}`, quantity: i + 1, description: "x".repeat(1000), price: i === 4 ? -10 : 100 }));
  const saved = await bob.saveInvoice(bobId, { id: "five-lines", invoice: value });
  const updated = await bob.saveInvoice(bobId, { ...saved, invoice: { ...saved.invoice, billTo: "UPDATED FIVE LINES" } });
  assert.equal(updated.revision, 2);
  await bob.deleteInvoice(bobId, updated.id, 2);
});

test("number reservations are atomic across devices and survive invoice deletion", async () => {
  const numbers = await Promise.all([alice.reserveInvoiceNumber("2026-10-01"), otherDevice.reserveInvoiceNumber("2026-10-01")]);
  assert.deepEqual(numbers.sort(), ["EHR-20261001-001", "EHR-20261001-002"]);
  assert.equal(await alice.nextInvoiceNumber("2026-10-01"), "EHR-20261001-003");
  const manual = await alice.saveInvoice(aliceId, { id: "manual-number", invoice: { ...invoice(), invoiceNumber: "EHR-20261001-009" } });
  await alice.deleteInvoice(aliceId, manual.id, manual.revision);
  assert.equal(await otherDevice.reserveInvoiceNumber("2026-10-01"), "EHR-20261001-010");
  assert.equal(await bob.reserveInvoiceNumber("2026-10-01"), "EHR-20261001-001");
});

test("pagination, customer/number search, account backups and retryable local imports", async () => {
  const records = Array.from({ length: 6 }, (_, index) => ({ id: `import-${index}`, createdAt: "2026-08-01T00:00:00.000Z", invoice: invoice(`IMPORT CUSTOMER ${index}`) }));
  await alice.migrateLocalData(aliceId, records, null);
  await alice.migrateLocalData(aliceId, records, null);
  const first = await alice.listInvoices(aliceId, { limit: 3 });
  const second = await alice.listInvoices(aliceId, { limit: 3, cursor: first.nextCursor });
  assert.equal(first.total, 7);
  assert.equal(first.records.length, 3);
  assert.equal(second.records.length, 3);
  assert.equal(new Set([...first.records, ...second.records].map((record) => record.id)).size, 6);
  const match = await alice.listInvoices(aliceId, { query: "customer 3" });
  assert.equal(match.total, 1);
  assert.equal(match.records[0].createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal((await alice.listInvoices(aliceId, { query: "20260912" })).total, 7);
  const backup = await alice.exportAccountData(aliceId);
  assert.equal(backup.history.length, 7);
  assert.ok(backup.sequences.some((entry) => entry.date === "20261001" && entry.sequence === 10));
  await bob.migrateLocalData(bobId, [], null, [{ date: "20261201", sequence: 42 }]);
  assert.equal(await bob.nextInvoiceNumber("2026-12-01"), "EHR-20261201-043");
  await assert.rejects(alice.migrateLocalData(aliceId, [{ ...records[0], invoice: invoice("COLLISION") }], null), /already belongs/);
  assert.equal((await alice.listInvoices(aliceId, { query: "COLLISION" })).total, 0);
  await alice.migrateLocalData(aliceId, [], invoice("LOCAL DRAFT"));
  await alice.migrateLocalData(aliceId, [], invoice("LOCAL DRAFT"));
  await assert.rejects(alice.migrateLocalData(aliceId, [], invoice("OTHER DRAFT")), /already has a draft/);
  assert.equal((await alice.loadDraft(aliceId)).invoice.billTo, "LOCAL DRAFT");
});

test("password reset uses Firebase action codes and permits login with the new password", async () => {
  await bob.sendPasswordReset("bob@example.test");
  const response = await fetch(`http://127.0.0.1:${ports.auth}/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = await response.json();
  const action = oobCodes.find((code) => code.email === "bob@example.test" && code.requestType === "PASSWORD_RESET");
  assert.ok(action);
  await bob.signOut();
  assert.equal(await bob.preparePasswordRecovery(`http://localhost/?mode=resetPassword&oobCode=${action.oobCode}`), true);
  await bob.updatePassword("Reset-password-123!");
  await bob.signIn("bob@example.test", "Reset-password-123!");
  assert.equal((await bob.getSession()).user.id, bobId);
  await assert.rejects(bob.signIn("bob@example.test", "Test-password-123!"));
});
