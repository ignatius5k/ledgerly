"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = join(__dirname, "..");

class EventSource {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, callback, options = {}) {
    const listeners = this.listeners.get(name) || [];
    listeners.push({ callback, once: Boolean(options.once) });
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    const listeners = this.listeners.get(name) || [];
    this.listeners.set(name, listeners.filter((listener) => !listener.once));
    listeners.forEach((listener) => listener.callback({ target: this }));
  }
}

function createIndexedDb(options = {}) {
  const stores = new Map();
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    addEventListener() {},
    close() {},
    transaction(name) {
      const transaction = new EventSource();
      transaction.error = null;
      transaction.objectStore = () => {
        const values = stores.get(name);
        const makeRequest = (action) => {
          const request = new EventSource();
          queueMicrotask(() => {
            try {
              request.result = action();
              request.dispatch("success");
            } catch (error) {
              request.error = error;
              request.dispatch("error");
            }
          });
          return request;
        };
        return {
          get(key) {
            return makeRequest(() => structuredClone(values.get(key)));
          },
          put(value) {
            const request = makeRequest(() => {
              values.set(value.userId, structuredClone(value));
              return value.userId;
            });
            return request;
          },
          delete(key) {
            return makeRequest(() => {
              const removed = values.delete(key);
              options.afterDelete?.(key);
              return removed;
            });
          },
        };
      };
      setTimeout(() => transaction.dispatch("complete"), 5);
      return transaction;
    },
  };

  return {
    open() {
      const request = new EventSource();
      queueMicrotask(async () => {
        if (options.openGate) await options.openGate;
        request.result = database;
        request.dispatch("upgradeneeded");
        request.dispatch("success");
      });
      return request;
    },
  };
}

function createLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

async function loadOutbox(indexedDb = createIndexedDb(), localStorage) {
  const source = await readFile(join(ROOT, "outbox.js"), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    window,
    indexedDB: indexedDb,
    localStorage,
    crypto: webcrypto,
    Date,
    Math,
    Promise,
    structuredClone,
    setTimeout,
  });
  return window.invoiceDraftOutbox;
}

test("draft outbox keeps the newest per-user operation until matching removal", async () => {
  const indexedDb = createIndexedDb();
  const outbox = await loadOutbox(indexedDb);
  const first = await outbox.putSave("user-1", { invoiceNumber: "INV-1" }, 2);
  const second = await outbox.putSave("user-1", { invoiceNumber: "INV-2" }, 2);
  await outbox.putDelete("user-2", 4);

  const recoveredOutbox = await loadOutbox(indexedDb);
  assert.equal((await recoveredOutbox.get("user-1")).invoice.invoiceNumber, "INV-2");
  assert.equal(await outbox.remove("user-1", first.operationId), false);
  assert.equal(await outbox.has("user-1"), true);
  assert.equal((await outbox.get("user-2")).type, "delete");
  assert.equal(await outbox.remove("user-1", second.operationId), true);
  assert.equal(await outbox.has("user-1"), false);
});

test("draft outbox persists retry metadata and can rebase after an explicit conflict choice", async () => {
  const outbox = await loadOutbox();
  const operation = await outbox.putSave("user-1", { invoiceNumber: "INV-3" });
  await outbox.markRetry("user-1", operation.operationId, 3, 12345, "offline");
  const retry = await outbox.get("user-1");
  assert.deepEqual(
    { attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt, lastError: retry.lastError },
    { attempts: 3, nextAttemptAt: 12345, lastError: "offline" },
  );

  await outbox.rebase("user-1", operation.operationId, 9);
  const rebased = await outbox.get("user-1");
  assert.deepEqual(
    { expectedRevision: rebased.expectedRevision, attempts: rebased.attempts, nextAttemptAt: rebased.nextAttemptAt },
    { expectedRevision: 9, attempts: 0, nextAttemptAt: 0 },
  );
});

test("draft outbox keeps a session fallback when IndexedDB is unavailable", async () => {
  const outbox = await loadOutbox({
    open() {
      throw new Error("IndexedDB denied");
    },
  });
  const operation = await outbox.putSave("user-1", { invoiceNumber: "INV-FALLBACK" });
  assert.equal(operation.storage, "memory");
  assert.equal((await outbox.get("user-1")).storage, "memory");
  assert.equal((await outbox.get("user-1")).operationId, operation.operationId);
  assert.equal(await outbox.has("user-1"), true);
  assert.equal(await outbox.remove("user-1", operation.operationId), true);
  assert.equal(await outbox.has("user-1"), false);
});

test("draft recovery survives reload before queued writes and isolates account operations", async () => {
  const indexedDb = createIndexedDb();
  const localStorage = createLocalStorage();
  const outbox = await loadOutbox(indexedDb, localStorage);
  const acknowledged = await outbox.putSave("user-1", { invoiceNumber: "OLD" }, 1);
  const superseded = outbox.prepareSave("user-1", { invoiceNumber: "INTERMEDIATE" }, 1);
  const latest = outbox.prepareSave("user-1", { invoiceNumber: "LATEST" }, 1);
  outbox.prepareSave("user-2", { invoiceNumber: "OTHER ACCOUNT" }, 4);

  const reloaded = await loadOutbox(indexedDb, localStorage);
  assert.equal((await reloaded.get("user-1")).invoice.invoiceNumber, "LATEST");
  assert.equal((await reloaded.get("user-2")).invoice.invoiceNumber, "OTHER ACCOUNT");
  assert.equal(await reloaded.get("user-3"), null);
  assert.equal(await outbox.commit(superseded, 2), null, "an older queued write cannot replace the latest journal");
  assert.equal(await outbox.remove("user-1", acknowledged.operationId), false, "an earlier acknowledgement cannot clear a newer edit");
  await outbox.commit(latest, 2);
  assert.equal((await reloaded.get("user-1")).expectedRevision, 2);
  await reloaded.markRetry("user-1", latest.operationId, 2, 500, "offline");
  assert.equal((await (await loadOutbox(indexedDb, localStorage)).get("user-1")).attempts, 2);
  await reloaded.rebase("user-1", latest.operationId, 3);
  assert.equal((await outbox.get("user-1")).expectedRevision, 3);
  assert.equal(await reloaded.remove("user-1", latest.operationId), true);
  assert.equal(localStorage.getItem("invoice-studio-draft-recovery-v1:user-1"), null);
  assert.equal(await (await loadOutbox(indexedDb, localStorage)).get("user-1"), null, "cleared journal must not reveal an old IndexedDB draft");
  assert.equal((await reloaded.get("user-2")).invoice.invoiceNumber, "OTHER ACCOUNT");
});

test("a deletion staged before reload replaces the old IndexedDB save until acknowledgement", async () => {
  const indexedDb = createIndexedDb();
  const localStorage = createLocalStorage();
  const outbox = await loadOutbox(indexedDb, localStorage);
  await outbox.putSave("user-1", { invoiceNumber: "DELETE ME" }, 1);
  const deletion = outbox.prepareDelete("user-1", 2);
  const reloaded = await loadOutbox(indexedDb, localStorage);
  assert.equal((await reloaded.get("user-1")).type, "delete");
  assert.equal(await reloaded.remove("user-1", deletion.operationId), true);
  assert.equal(await (await loadOutbox(indexedDb, localStorage)).get("user-1"), null);
});

test("an edit staged during acknowledgement survives removal of the previous draft", async () => {
  let afterDelete;
  const indexedDb = createIndexedDb({ afterDelete: () => afterDelete?.() });
  const localStorage = createLocalStorage();
  const outbox = await loadOutbox(indexedDb, localStorage);
  const previous = await outbox.putSave("user-1", { invoiceNumber: "PREVIOUS" }, 1);
  let next;
  afterDelete = () => { next = outbox.prepareSave("user-1", { invoiceNumber: "NEW EDIT" }, 2); };
  assert.equal(await outbox.remove("user-1", previous.operationId), true);
  const reloaded = await loadOutbox(indexedDb, localStorage);
  assert.equal((await reloaded.get("user-1")).operationId, next.operationId);
  assert.equal((await reloaded.get("user-1")).invoice.invoiceNumber, "NEW EDIT");
});

test("localStorage recovery remains durable without IndexedDB and rejects mismatched or corrupt entries", async () => {
  const deniedDb = { open() { throw new Error("IndexedDB denied"); } };
  const localStorage = createLocalStorage();
  const outbox = await loadOutbox(deniedDb, localStorage);
  const operation = await outbox.putSave("user-1", { invoiceNumber: "RECOVERABLE" }, 1);
  assert.equal(operation.storage, "localstorage");
  const reloaded = await loadOutbox(deniedDb, localStorage);
  assert.equal((await reloaded.get("user-1")).operationId, operation.operationId);
  const otherKey = "invoice-studio-draft-recovery-v1:user-2";
  localStorage.setItem(otherKey, localStorage.getItem("invoice-studio-draft-recovery-v1:user-1"));
  assert.equal(await reloaded.get("user-2"), null, "a journal payload must match its account key");
  localStorage.setItem(otherKey, "{broken");
  assert.equal(await reloaded.get("user-2"), null);
  assert.equal(await reloaded.remove("user-1", operation.operationId), true);
  assert.equal(await (await loadOutbox(deniedDb, localStorage)).get("user-1"), null);
});

test("blocked or full localStorage reports memory-only unless IndexedDB can persist the draft", async () => {
  const unavailableStorage = {
    getItem() { throw new Error("Storage denied"); },
    setItem() { throw new Error("Quota exceeded"); },
    removeItem() { throw new Error("Storage denied"); },
  };
  const unavailableDb = { open() { throw new Error("IndexedDB denied"); } };
  const memoryOutbox = await loadOutbox(unavailableDb, unavailableStorage);
  const temporary = await memoryOutbox.putSave("user-1", { invoiceNumber: "MEMORY ONLY" });
  assert.equal(temporary.storage, "memory");
  assert.equal((await memoryOutbox.get("user-1")).storage, "memory");
  const indexedDb = createIndexedDb();
  const durableOutbox = await loadOutbox(indexedDb, unavailableStorage);
  const durable = await durableOutbox.putSave("user-1", { invoiceNumber: "INDEXEDDB" });
  assert.equal(durable.storage, "indexeddb");
  assert.equal((await durableOutbox.get("user-1")).storage, "indexeddb");
  assert.equal((await (await loadOutbox(indexedDb, unavailableStorage)).get("user-1")).invoice.invoiceNumber, "INDEXEDDB");
});

test("a larger draft that exceeds journal quota recovers its latest IndexedDB snapshot", async () => {
  const indexedDb = createIndexedDb();
  const localStorage = createLocalStorage();
  const outbox = await loadOutbox(indexedDb, localStorage);
  await outbox.putSave("user-1", { invoiceNumber: "OLD JOURNAL" }, 1);
  localStorage.setItem = () => { throw new Error("Quota exceeded"); };
  await outbox.putSave("user-1", { invoiceNumber: "LARGER NEW DRAFT", description: "x".repeat(1000) }, 2);
  const reloaded = await loadOutbox(indexedDb, localStorage);
  assert.equal((await reloaded.get("user-1")).invoice.invoiceNumber, "LARGER NEW DRAFT");
  assert.equal((await reloaded.get("user-1")).expectedRevision, 2);
});

test("commit clears a prepared revision after a preceding deletion and skips a superseded database open", async () => {
  let releaseOpen;
  const indexedDb = createIndexedDb({ openGate: new Promise((resolve) => { releaseOpen = resolve; }) });
  const localStorage = createLocalStorage();
  const outbox = await loadOutbox(indexedDb, localStorage);
  const first = outbox.prepareSave("user-1", { invoiceNumber: "OLD" }, 7);
  const pending = outbox.commit(first, 7);
  const latest = outbox.prepareSave("user-1", { invoiceNumber: "AFTER DELETE" }, 7);
  releaseOpen();
  assert.equal(await pending, null, "an operation superseded while opening IndexedDB must not be written");
  await outbox.commit(latest, undefined);
  const reloaded = await loadOutbox(indexedDb, localStorage);
  assert.equal((await reloaded.get("user-1")).expectedRevision, null, "an explicit undefined revision must clear the prepared base");
  await reloaded.remove("user-1", latest.operationId);
  assert.equal(await (await loadOutbox(indexedDb, localStorage)).get("user-1"), null);
});
