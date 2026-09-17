(function initializeInvoiceDraftOutbox() {
  "use strict";

  const DATABASE_NAME = "invoice-studio-reliability-v1";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "draft-outbox";
  const RECOVERY_KEY_PREFIX = "invoice-studio-draft-recovery-v1:";
  let databasePromise;
  const memoryFallback = new Map();

  function recoveryKey(userId) {
    return `${RECOVERY_KEY_PREFIX}${encodeURIComponent(userId)}`;
  }

  function readRecovery(userId) {
    const memoryValue = memoryFallback.get(userId);
    if (memoryValue) return memoryValue;
    try {
      const value = JSON.parse(localStorage.getItem(recoveryKey(userId)));
      if (value?.userId === userId && typeof value.operationId === "string"
        && ["save", "delete"].includes(value.type)) return { ...value, storage: "localstorage" };
    } catch {}
    return null;
  }

  function saveRecovery(operation) {
    // This must run synchronously in the input/pagehide event. Browsers may
    // terminate the document before a queued IndexedDB transaction can start.
    const value = { ...operation };
    delete value.storage;
    try {
      localStorage.setItem(recoveryKey(value.userId), JSON.stringify(value));
      memoryFallback.delete(value.userId);
      return { ...value, storage: "localstorage" };
    } catch {
      // A full storage area can reject this larger snapshot while still
      // retaining an older one. Do not let that obsolete journal hide a newer
      // successful IndexedDB write when the page next opens.
      try { localStorage.removeItem(recoveryKey(value.userId)); } catch {}
      const memoryValue = { ...value, storage: "memory" };
      memoryFallback.set(value.userId, memoryValue);
      return memoryValue;
    }
  }

  function markIndexedDbSaved(operation) {
    // A newer operation or retry may have been staged during the transaction.
    if (memoryFallback.get(operation.userId) === operation) {
      memoryFallback.set(operation.userId, { ...operation, storage: "indexeddb" });
    }
  }

  function removeRecovery(userId, expectedOperationId) {
    if (memoryFallback.get(userId)?.operationId === expectedOperationId) memoryFallback.delete(userId);
    try {
      const value = JSON.parse(localStorage.getItem(recoveryKey(userId)));
      if (value?.userId === userId && value.operationId === expectedOperationId) localStorage.removeItem(recoveryKey(userId));
    } catch {}
  }

  function operationId() {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction was aborted.")), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "userId" });
        }
      });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close());
        resolve(database);
      }, { once: true });
      request.addEventListener("error", () => {
        databasePromise = undefined;
        reject(request.error || new Error("IndexedDB could not be opened."));
      }, { once: true });
      request.addEventListener("blocked", () => {
        databasePromise = undefined;
        reject(new Error("IndexedDB upgrade is blocked by another tab."));
      }, { once: true });
    });
    return databasePromise;
  }

  async function read(userId) {
    if (!userId) return null;
    const recovery = readRecovery(userId);
    if (recovery) return recovery;
    try {
      const database = await openDatabase();
      const transaction = database.transaction(STORE_NAME, "readonly");
      const value = await requestResult(transaction.objectStore(STORE_NAME).get(userId));
      await transactionComplete(transaction);
      return readRecovery(userId) || (value ? { ...value, storage: "indexeddb" } : null);
    } catch {
      return readRecovery(userId);
    }
  }

  async function commit(operation, expectedRevision) {
    const current = readRecovery(operation.userId);
    if (current?.operationId !== operation.operationId) return null;
    // Revisions can advance while this operation waits behind an earlier write.
    // Preserve its snapshot but use the queue's current acknowledged revision.
    let prepared = saveRecovery({ ...current, expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : null });
    try {
      const database = await openDatabase();
      const latest = readRecovery(operation.userId);
      if (latest?.operationId !== operation.operationId) return null;
      prepared = latest;
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(prepared);
      await transactionComplete(transaction);
      markIndexedDbSaved(prepared);
      // Keep the recovery journal until backend acknowledgement. A crash after
      // an IndexedDB commit must not let an older queued write win on reload.
      return { ...prepared, storage: "indexeddb" };
    } catch {
      // The synchronous journal (or memory fallback when storage is denied)
      // still lets the backend flush this operation when IndexedDB fails.
      return prepared;
    }
  }

  function operationFor(userId, type, invoice, expectedRevision) {
    return {
      userId,
      operationId: operationId(),
      type,
      invoice: invoice || null,
      expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : null,
      createdAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
    };
  }

  function prepareSave(userId, invoice, expectedRevision) {
    if (!userId || !invoice) throw new Error("A user and draft are required.");
    return saveRecovery(operationFor(userId, "save", invoice, expectedRevision));
  }

  function prepareDelete(userId, expectedRevision) {
    if (!userId) throw new Error("A user is required.");
    return saveRecovery(operationFor(userId, "delete", null, expectedRevision));
  }

  async function putSave(userId, invoice, expectedRevision) {
    return commit(prepareSave(userId, invoice, expectedRevision), expectedRevision);
  }

  async function putDelete(userId, expectedRevision) {
    return commit(prepareDelete(userId, expectedRevision), expectedRevision);
  }

  async function updateMatching(userId, expectedOperationId, updater) {
    let database;
    let transaction;
    let store;
    let storedValue = null;
    try {
      database = await openDatabase();
      transaction = database.transaction(STORE_NAME, "readwrite");
      store = transaction.objectStore(STORE_NAME);
      storedValue = await requestResult(store.get(userId));
    } catch {}
    const current = readRecovery(userId) || storedValue;
    let updated = null;
    if (current && (!expectedOperationId || current.operationId === expectedOperationId)) {
      updated = saveRecovery(updater(current) || current);
      store?.put(updated);
    }
    if (transaction) {
      try {
        await transactionComplete(transaction);
        if (updated) markIndexedDbSaved(updated);
      } catch {}
    }
    return updated;
  }

  function markRetry(userId, expectedOperationId, attempts, nextAttemptAt, errorMessage) {
    return updateMatching(userId, expectedOperationId, (operation) => ({
      ...operation,
      attempts,
      nextAttemptAt,
      lastError: String(errorMessage || "").slice(0, 500),
    }));
  }

  function rebase(userId, expectedOperationId, expectedRevision) {
    return updateMatching(userId, expectedOperationId, (operation) => ({
      ...operation,
      expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
    }));
  }

  async function remove(userId, expectedOperationId) {
    let database;
    let transaction;
    let store;
    let storedValue = null;
    try {
      database = await openDatabase();
      transaction = database.transaction(STORE_NAME, "readwrite");
      store = transaction.objectStore(STORE_NAME);
      storedValue = await requestResult(store.get(userId));
    } catch {}
    const current = readRecovery(userId) || storedValue;
    const removed = Boolean(current && (!expectedOperationId || current.operationId === expectedOperationId));
    if (removed) {
      store?.delete(userId);
    }
    if (transaction) {
      try {
        await transactionComplete(transaction);
      } catch { return false; }
    }
    if (removed) removeRecovery(userId, current.operationId);
    return removed;
  }

  async function has(userId) {
    return Boolean(await read(userId));
  }

  window.invoiceDraftOutbox = Object.freeze({
    get: read,
    has,
    prepareSave,
    prepareDelete,
    commit,
    putSave,
    putDelete,
    markRetry,
    rebase,
    remove,
  });
}());
