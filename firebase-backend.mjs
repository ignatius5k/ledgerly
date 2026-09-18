import { initializeApp } from "firebase/app";
import { createGoogleTokenSignIn } from "./google-sign-in.mjs";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence,
  inMemoryPersistence, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
  updatePassword, verifyPasswordResetCode, confirmPasswordReset,
  connectAuthEmulator, GoogleAuthProvider, signInWithPopup, signInWithCredential, browserPopupRedirectResolver,
} from "firebase/auth";
import {
  initializeFirestore, memoryLocalCache, collection, doc, getDocFromServer,
  getDocsFromServer, getCountFromServer, query, orderBy, documentId,
  limit, startAfter, runTransaction, serverTimestamp, Timestamp,
  connectFirestoreEmulator, terminate,
} from "firebase/firestore";
import { getStorage, ref as storageRef, uploadBytes, getBlob, getMetadata, connectStorageEmulator } from "firebase/storage";

const copy = (value) => JSON.parse(JSON.stringify(value));
const failure = (code, message) => Object.assign(new Error(message), { code });
const conflict = (kind) => failure(`${kind.toUpperCase()}_REVISION_CONFLICT`, `This ${kind} changed on another device. Reload the saved copy before trying again.`);
const MAX_PDF_BYTES = 10 * 1024 * 1024;

function validId(value) {
  if (typeof value !== "string" || !value || value.length > 160 || value.includes("/") || value === "." || value === "..") {
    throw new Error("This invoice has an invalid identifier.");
  }
  return value;
}

function cleanInvoice(invoice) {
  if (!invoice || !Array.isArray(invoice.items) || invoice.items.length < 1 || invoice.items.length > 5) {
    throw new Error("An invoice must contain between one and five items.");
  }
  const value = copy(invoice);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 50000) throw new Error("This invoice is too large to save.");
  return value;
}

function asRecord(data) {
  return {
    ...data,
    createdAt: data.createdAt?.toDate().toISOString(),
    updatedAt: data.updatedAt?.toDate().toISOString(),
  };
}

function numberParts(number) {
  const match = String(number || "").match(/^EHR-(\d{8})-(\d{1,6})$/);
  return match && Number(match[2]) > 0 ? { date: match[1], sequence: Number(match[2]) } : null;
}

function canonicalInvoice(value) {
  return JSON.stringify(value, function (key, val) {
    if (key === "historyRevision") return undefined;
    return val && !Array.isArray(val) && typeof val === "object"
      ? Object.fromEntries(Object.keys(val).sort().map((name) => [name, val[name]])) : val;
  });
}

export function createFirebaseInvoiceBackend(config, localBackend, options = {}) {
  const environment = options.environment || (typeof window !== "undefined" ? window : null);
  const userAgent = environment?.navigator?.userAgent || "";
  const webKit = /AppleWebKit/i.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//i.test(userAgent);
  const googleClientId = config.googleClientId || (config.projectId === "ledgerly-e0c95"
    ? "245799445908-rbu5tip6b78cb3l0jef49nt1mcaf27rh.apps.googleusercontent.com" : null);
  const useDirectGoogle = webKit && !options.emulators && googleClientId && environment?.document;
  const app = initializeApp(config, options.appName || "ledgerly");
  const auth = initializeAuth(app, {
    persistence: options.memoryAuth ? inMemoryPersistence
      : [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence],
    // Direct Google credentials do not need Firebase's cross-site auth iframe.
    // Keeping the resolver here would still initialize that iframe on Safari.
    ...(options.memoryAuth || useDirectGoogle ? {} : { popupRedirectResolver: browserPopupRedirectResolver }),
  });
  // Cloud invoices are kept in memory. Only unsynced drafts use the existing,
  // account-keyed outbox, so another login cannot read a previous user's cache.
  const directGoogleSignIn = useDirectGoogle
    ? createGoogleTokenSignIn(environment, googleClientId) : null;
  const db = initializeFirestore(app, {
    localCache: memoryLocalCache(),
    // WebKit can stall the streaming connection when returning from OAuth or
    // restoring a page. Short-lived polls also work in iOS home-screen apps.
    ...(webKit ? { experimentalForceLongPolling: true } : {}),
  });
  const pdfStorageAvailable = typeof config.storageBucket === "string" && Boolean(config.storageBucket.trim());
  const storage = pdfStorageAvailable ? getStorage(app) : null;
  if (storage) {
    storage.maxUploadRetryTime = 15000;
    storage.maxOperationRetryTime = 15000;
  }
  if (options.emulators) {
    const hostname = environment?.location?.hostname;
    if (!options.memoryAuth && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      throw new Error("Firebase emulators may only be used on localhost.");
    }
    connectAuthEmulator(auth, `http://127.0.0.1:${options.emulators.auth || 9099}`, { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", options.emulators.firestore || 8080);
    if (storage) connectStorageEmulator(storage, "127.0.0.1", options.emulators.storage || 9199);
  }

  const listeners = new Set();
  const session = () => auth.currentUser ? { user: { id: auth.currentUser.uid, email: auth.currentUser.email } } : null;
  let lastUid;
  let initial = true;
  let resetCode;
  onAuthStateChanged(auth, (user) => {
    const event = initial ? "INITIAL_SESSION" : user ? "SIGNED_IN" : "SIGNED_OUT";
    const changed = initial || lastUid !== user?.uid;
    initial = false;
    lastUid = user?.uid;
    if (changed) for (const listener of listeners) listener(event, session());
  });

  function owner(userId = auth.currentUser?.uid) {
    if (!userId || auth.currentUser?.uid !== userId) throw failure("auth/user-token-expired", "Sign in again to access your invoices.");
    return userId;
  }

  function online(userId) {
    owner(userId);
    if (environment?.navigator?.onLine === false) throw failure("unavailable", "Reconnect to save invoices to your account. Your draft remains on this device.");
  }

  const invoices = (uid) => collection(db, "users", owner(uid), "invoices");
  const invoiceRef = (uid, id) => doc(invoices(uid), validId(id));
  const draftRef = (uid) => doc(db, "users", owner(uid), "drafts", "current");
  const sequenceRef = (uid, date) => doc(db, "users", owner(uid), "sequences", date);
  function checkRevision(existing, expected, kind) {
    const current = existing && !existing.deleted ? existing.revision : undefined;
    if (current !== expected && !(current === undefined && (expected === undefined || expected === 0))) throw conflict(kind);
  }

  async function revisionTransaction(uid, ref, expectedRevision, kind, action) {
    try { return await runTransaction(db, action); }
    catch (error) {
      if (error.code === "permission-denied") {
        // Rules can reject a stale revision before the transaction retry. Read
        // the latest authorized copy to distinguish contention from bad rules.
        const latest = (await getDocFromServer(ref)).data();
        owner(uid);
        checkRevision(latest, expectedRevision, kind);
      }
      throw error;
    }
  }

  async function listInvoices(userId, options = {}) {
    online(userId);
    const pageSize = Math.min(50, Math.max(1, Number(options.limit) || 25));
    const search = String(options.query || "").trim().toLocaleLowerCase("en-SG").slice(0, 120);
    const source = invoices(userId);
    const ordering = [orderBy("updatedAt", "desc"), orderBy(documentId(), "desc")];
    const cursor = options.cursor;
    const after = cursor?.id && cursor?.timestamp
      ? [startAfter(new Timestamp(cursor.timestamp.seconds, cursor.timestamp.nanoseconds), validId(cursor.id))] : [];
    let documents;
    let total;
    if (search) {
      // Preserve the editor's substring search semantics. Firestore has no native
      // substring index; only this user's collection is scanned for a search.
      const snapshot = await getDocsFromServer(query(source, ...ordering));
      owner(userId);
      const matching = snapshot.docs.filter((entry) => {
        const invoice = entry.data().invoice;
        return `${invoice.invoiceNumber || ""} ${invoice.billTo || ""}`.toLocaleLowerCase("en-SG").includes(search);
      });
      total = matching.length;
      const position = cursor?.id ? matching.findIndex((entry) => entry.id === cursor.id) : -1;
      documents = matching.slice(position + 1, position + pageSize + 2);
    } else {
      const [snapshot, count] = await Promise.all([
        getDocsFromServer(query(source, ...ordering, ...after, limit(pageSize + 1))),
        getCountFromServer(source),
      ]);
      owner(userId);
      documents = snapshot.docs;
      total = count.data().count;
    }
    const page = documents.slice(0, pageSize);
    const last = page.at(-1);
    const timestamp = last?.data().updatedAt;
    return {
      records: page.map((entry) => asRecord(entry.data())), total,
      nextCursor: documents.length > pageSize && last ? {
        id: last.id, timestamp: { seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds },
      } : null,
    };
  }

  async function saveInvoice(userId, record) {
    online(userId);
    const ref = invoiceRef(userId, record.id);
    const invoice = { ...cleanInvoice(record.invoice), historyId: record.id, draftDirty: false };
    const numbering = numberParts(invoice.invoiceNumber);
    return revisionTransaction(userId, ref, record.revision, "invoice", async (transaction) => {
      online(userId);
      const existing = (await transaction.get(ref)).data();
      const sequence = numbering ? await transaction.get(sequenceRef(userId, numbering.date)) : null;
      checkRevision(existing, record.revision, "invoice");
      const now = Timestamp.now();
      const revision = (existing?.revision || 0) + 1;
      const originalDate = record.createdAt && new Date(record.createdAt);
      const importedCreatedAt = originalDate && Number.isFinite(originalDate.getTime()) && originalDate <= new Date()
        ? Timestamp.fromDate(originalDate) : null;
      const saved = {
        id: record.id, revision,
        createdAt: existing?.createdAt || importedCreatedAt || now, updatedAt: now,
        invoice: { ...invoice, historyRevision: revision },
      };
      transaction.set(ref, { ...saved, createdAt: existing?.createdAt || importedCreatedAt || serverTimestamp(), updatedAt: serverTimestamp() });
      if (numbering && numbering.sequence > (sequence?.data()?.sequence || 0)) {
        transaction.set(sequenceRef(userId, numbering.date), { sequence: numbering.sequence });
      }
      return asRecord(saved);
    });
  }

  async function deleteInvoice(userId, id, expectedRevision) {
    online(userId);
    const ref = invoiceRef(userId, id);
    return runTransaction(db, async (transaction) => {
      online(userId);
      const existing = (await transaction.get(ref)).data();
      if (!existing) return false;
      checkRevision(existing, expectedRevision, "invoice");
      transaction.delete(ref);
      return true;
    });
  }

  async function currentPdfInvoice(uid, record) {
    online(uid);
    if (!storage) throw failure("PDF_STORAGE_UNAVAILABLE", "PDF storage is not configured. Your invoice data is saved, but its PDF has not been uploaded.");
    validId(record?.id);
    if (!Number.isSafeInteger(record?.revision) || record.revision < 1) {
      throw failure("PDF_INVALID_REVISION", "Save the invoice before saving its PDF to your account.");
    }
    const saved = (await getDocFromServer(invoiceRef(uid, record.id))).data();
    owner(uid);
    if (!saved) throw failure("INVOICE_NOT_FOUND", "This invoice is no longer saved in your account. Save the invoice before uploading its PDF.");
    if (saved.revision !== record.revision) throw conflict("invoice");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalInvoice(saved.invoice)));
    const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    owner(uid);
    return { target: storageRef(storage, `users/${uid}/invoices/${record.id}/revisions/${record.revision}.pdf`), fingerprint };
  }

  function checkPdfFingerprint(metadata, fingerprint) {
    if (metadata.customMetadata?.invoiceFingerprint !== fingerprint) {
      throw failure("PDF_CONTENT_CONFLICT", "A different PDF is already stored for this invoice revision. Save the invoice again to create a new revision before saving its PDF.");
    }
  }

  async function saveInvoicePdf(uid, record, blob) {
    online(uid);
    if (!(blob instanceof Blob) || blob.type !== "application/pdf" || blob.size < 5 || blob.size > MAX_PDF_BYTES) {
      throw failure("PDF_INVALID_FILE", "The invoice PDF must be a PDF file no larger than 10 MiB.");
    }
    if (await blob.slice(0, 5).text() !== "%PDF-") throw failure("PDF_INVALID_FILE", "The generated file is not a valid PDF.");
    const { target, fingerprint } = await currentPdfInvoice(uid, record);
    let metadata;
    let alreadySaved = false;
    try {
      metadata = await getMetadata(target);
      alreadySaved = true;
    } catch (error) {
      if (error.code !== "storage/object-not-found") throw error;
      // A revision is immutable. If another device uploads it first, the rules
      // reject our update and we reuse that successfully stored PDF.
      try {
        metadata = (await uploadBytes(target, blob, {
          contentType: "application/pdf", cacheControl: "private, no-store",
          customMetadata: { invoiceId: record.id, revision: String(record.revision), invoiceFingerprint: fingerprint },
        })).metadata;
      } catch (uploadError) {
        if (uploadError.code !== "storage/unauthorized") throw uploadError;
        try { metadata = await getMetadata(target); alreadySaved = true; }
        catch { throw uploadError; }
      }
    }
    checkPdfFingerprint(metadata, fingerprint);
    checkPdfFingerprint(metadata, (await currentPdfInvoice(uid, record)).fingerprint);
    return { path: target.fullPath, revision: record.revision, size: metadata.size, alreadySaved };
  }

  async function loadInvoicePdf(uid, record) {
    const { target, fingerprint } = await currentPdfInvoice(uid, record);
    const metadata = await getMetadata(target);
    checkPdfFingerprint(metadata, fingerprint);
    // Authenticated SDK download: never create or persist a public download URL.
    const blob = await getBlob(target, MAX_PDF_BYTES);
    checkPdfFingerprint(metadata, (await currentPdfInvoice(uid, record)).fingerprint);
    if (blob.size < 5 || await blob.slice(0, 5).text() !== "%PDF-") {
      throw failure("PDF_INVALID_FILE", "The saved file is not a valid PDF. Save a new invoice revision to create another PDF.");
    }
    // Some browser/Storage emulator responses omit the Blob MIME type despite
    // correct object metadata; preserve PDF opening and printing behavior.
    return blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });
  }

  async function loadDraft(userId) {
    online(userId);
    const data = (await getDocFromServer(draftRef(userId))).data();
    owner(userId);
    return data && !data.deleted ? { invoice: data.invoice, revision: data.revision } : null;
  }

  async function writeDraft(userId, invoice, signal, expectedRevision) {
    online(userId);
    const ref = draftRef(userId);
    const value = invoice ? cleanInvoice(invoice) : null;
    return revisionTransaction(userId, ref, expectedRevision, "draft", async (transaction) => {
      online(userId);
      if (signal?.aborted) throw Object.assign(new Error("Draft operation cancelled."), { name: "AbortError" });
      const existing = (await transaction.get(ref)).data();
      if (!value && (!existing || existing.deleted)) return;
      checkRevision(existing, expectedRevision, "draft");
      const revision = (existing?.revision || 0) + 1;
      // A tombstone keeps revisions increasing across delete/recreate cycles.
      transaction.set(ref, { invoice: value, revision, deleted: !value, updatedAt: serverTimestamp() });
      return { revision };
    });
  }

  async function allocateNumber(invoiceDate, reserve) {
    const uid = owner();
    online(uid);
    const date = String(invoiceDate).replace(/-/g, "");
    if (!/^\d{8}$/.test(date)) throw new Error("Choose a valid invoice date.");
    const ref = sequenceRef(uid, date);
    const format = (value) => {
      if (value > 999999) throw new Error("The invoice sequence for this date is full.");
      return `EHR-${date}-${String(value).padStart(3, "0")}`;
    };
    if (!reserve) {
      const snapshot = await getDocFromServer(ref);
      owner(uid);
      return format((snapshot.data()?.sequence || 0) + 1);
    }
    return runTransaction(db, async (transaction) => {
      online(uid);
      const sequence = ((await transaction.get(ref)).data()?.sequence || 0) + 1;
      const number = format(sequence);
      transaction.set(ref, { sequence });
      return number;
    });
  }

  async function migrateLocalData(uid, records, draft, sequences = []) {
    online(uid);
    const prepared = (records || []).map((record) => ({ ...record, id: validId(record.id), invoice: cleanInvoice(record.invoice) }));
    const localDraft = draft ? cleanInvoice(draft) : null;
    const numbering = Array.isArray(sequences) ? sequences : [sequences];
    for (const value of numbering) {
      if (!value || !/^\d{8}$/.test(value.date) || !Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > 999999) {
        throw new Error("The backup contains an invalid invoice sequence.");
      }
    }
    // Import is retryable: existing IDs are never overwritten. A colliding record
    // must be resolved by the user, with the original browser backup preserved.
    for (const record of prepared) {
      const existing = (await getDocFromServer(invoiceRef(uid, record.id))).data();
      owner(uid);
      if (existing) {
        const desired = { ...record.invoice, historyId: record.id, draftDirty: false };
        if (canonicalInvoice(existing.invoice) !== canonicalInvoice(desired)) throw new Error("An imported invoice ID already belongs to a different saved invoice. Your local copy is preserved; download its backup before continuing.");
      } else {
        await saveInvoice(uid, { ...record, revision: undefined });
      }
    }
    for (const value of numbering) {
      await runTransaction(db, async (transaction) => {
        online(uid);
        const ref = sequenceRef(uid, value.date);
        const previous = (await transaction.get(ref)).data()?.sequence || 0;
        if (value.sequence > previous) transaction.set(ref, { sequence: value.sequence });
      });
    }
    if (localDraft) {
      if (prepared.some((record) => record.id === localDraft.historyId)) {
        const imported = (await getDocFromServer(invoiceRef(uid, localDraft.historyId))).data();
        owner(uid);
        localDraft.historyRevision = imported.revision;
      }
      const saved = await loadDraft(uid);
      if (saved && canonicalInvoice(saved.invoice) !== canonicalInvoice(localDraft)) throw new Error("Your account already has a draft. The invoices have been imported and the local copy is preserved. Review the account draft before importing the local draft.");
      if (!saved) await writeDraft(uid, localDraft, undefined, undefined);
    }
    return { imported: prepared.length };
  }

  return {
    configured: true, guestMode: false, localMode: false, provider: "firebase",
    async getSession() { await auth.authStateReady(); return session(); },
    onAuthStateChange(callback) { listeners.add(callback); return { unsubscribe: () => listeners.delete(callback) }; },
    async signIn(email, password) { await signInWithEmailAndPassword(auth, email, password); return { session: session() }; },
    async signInWithGoogle() {
      if (directGoogleSignIn) {
        const token = await directGoogleSignIn();
        await signInWithCredential(auth, GoogleAuthProvider.credential(null, token));
        return { session: session() };
      }
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      // Keep the popup flow on Pages: cross-domain redirects cannot reliably
      // recover their result under Safari's third-party storage restrictions.
      await signInWithPopup(auth, provider, browserPopupRedirectResolver);
      return { session: session() };
    },
    async signUp(email, password) { await createUserWithEmailAndPassword(auth, email, password); return { session: session() }; },
    async sendPasswordReset(email) {
      try { await sendPasswordResetEmail(auth, email); }
      catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    },
    async preparePasswordRecovery(url) {
      const params = new URL(url).searchParams;
      if (params.get("mode") !== "resetPassword") return false;
      resetCode = params.get("oobCode");
      if (!resetCode) throw new Error("This password reset link is incomplete. Request a new one.");
      await verifyPasswordResetCode(auth, resetCode);
      return true;
    },
    async updatePassword(password) {
      if (resetCode) { await confirmPasswordReset(auth, resetCode, password); resetCode = undefined; }
      else { owner(); await updatePassword(auth.currentUser, password); }
    },
    signOut: () => signOut(auth),
    listInvoices, saveInvoice, deleteInvoice, loadDraft,
    pdfStorageAvailable, saveInvoicePdf, loadInvoicePdf,
    saveDraft: writeDraft,
    deleteDraft: (uid, signal, revision) => writeDraft(uid, null, signal, revision),
    nextInvoiceNumber: (date) => allocateNumber(date, false),
    reserveInvoiceNumber: (date) => allocateNumber(date, true),
    migrateLocalData,
    async exportAccountData(uid) {
      online(uid);
      const [history, draft, sequences] = await Promise.all([
        getDocsFromServer(invoices(uid)), loadDraft(uid),
        getDocsFromServer(collection(db, "users", uid, "sequences")),
      ]);
      owner(uid);
      return { version: 1, exportedAt: new Date().toISOString(), source: "Ledgerly Firebase account", history: history.docs.map((entry) => asRecord(entry.data())), draft: draft?.invoice || null, draftRevision: draft?.revision || null,
        sequences: sequences.docs.map((entry) => ({ date: entry.id, sequence: entry.data().sequence })) };
    },
    exportLocalData: localBackend?.exportLocalData,
    restoreLocalData: localBackend?.restoreLocalData,
    clearLocalData: localBackend?.clearLocalData,
    // Used by emulator tests to release SDK connections after each scenario.
    close: () => terminate(db),
  };
}

if (typeof window !== "undefined") window.createFirebaseInvoiceBackend = createFirebaseInvoiceBackend;
