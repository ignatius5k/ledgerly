const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { mkdtemp, readFile, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { startServer, connectCdp, waitFor, evaluate, findChromePath } = require("./browser-helpers");

async function launchFirebaseBrowser(context) {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Run this test with npm run test:firebase.");
  const chromePath = await findChromePath();
  assert.ok(chromePath, "Chrome is required for Firebase browser coverage.");
  const server = await startServer({ firebase: true });
  const appUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = await mkdtemp(join(tmpdir(), "ledgerly-firebase-test-"));
  const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", appUrl], { stdio: ["ignore", "ignore", "pipe"] });
  context.after(async () => {
    chrome.kill(); server.closeAllConnections(); server.close();
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  let logs = "";
  chrome.stderr.on("data", (chunk) => { logs += chunk; });
  const socket = await waitFor(() => logs.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 15000);
  const targets = await (await fetch(`http://127.0.0.1:${new URL(socket).port}/json/list`)).json();
  const page = await connectCdp(targets.find((entry) => entry.type === "page").webSocketDebuggerUrl);
  context.after(() => page.close());
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");
  const exceptions = [];
  page.on("Runtime.exceptionThrown", (entry) => exceptions.push(entry.exceptionDetails?.exception?.description || entry.exceptionDetails?.text));
  const read = (script) => evaluate(page, script);
  const until = async (script) => {
    try { return await waitFor(() => read(`Boolean(document.querySelector('#authPage')) && (${script})`), 20000); }
    catch (error) {
      throw new Error(`${error.message}: ${script}\n${await read("document.body.innerText")}\n${exceptions.join("\n")}`);
    }
  };
  await until("!document.querySelector('#authPage').hidden && document.querySelector('#appLoadingScreen').hidden");
  assert.equal(await read("window.invoiceBackend.provider"), "firebase");
  return { page, read, until, socket, exceptions, profile };
}

test("Firebase mobile signup, invoice save, session reload, offline draft recovery and account isolation", { timeout: 90000 }, async (context) => {
  const { page, read, until, exceptions } = await launchFirebaseBrowser(context);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true, "mobile login must fit the screen");
  const email = `browser-${Date.now()}@example.test`;
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  assert.equal(await read("document.querySelector('#accountEmail').textContent"), email);
  await read("document.querySelector('#historyNewInvoiceButton').click(); true");
  await until("!document.querySelector('#editorPage').hidden");
  await read(`(() => {
    const save = window.invoiceBackend.saveInvoice;
    window.invoiceBackend.saveInvoice = async (...args) => {
      await new Promise(resolve => { window.releaseInvoiceSave = resolve; });
      return save(...args);
    };
  })()`);
  await read(`(() => {
    const set = (selector, value) => { const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); };
    set('#billTo','BROWSER CUSTOMER');
    set('[data-item-field="description"]','Monthly rental');
    set('[data-item-field="price"]','125');
    document.querySelector('#printButton').click();
  })()`);
  await until("typeof window.releaseInvoiceSave === 'function'");
  assert.equal(await read("document.querySelector('#invoiceForm').inert && document.querySelector('#newInvoiceButton').disabled && document.querySelector('#signOutButton').disabled"), true);
  await read("window.releaseInvoiceSave(); true");
  await until("document.querySelector('#outputDialog').open && document.querySelector('#outputDialog').getAttribute('aria-busy')!=='true'");
  assert.equal(await read("document.querySelector('#cloudPdfStatus').dataset.state"), "saved", "Save invoice must automatically persist the PDF");
  await read("document.querySelector('#cancelOutputDialogButton').click(); location.reload(); true");
  await until("!document.querySelector('#invoiceListPage').hidden && document.querySelectorAll('.invoice-record').length===1");
  assert.match(await read("document.querySelector('.invoice-customer').textContent"), /BROWSER CUSTOMER/);
  for (const width of [320, 390]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await read("[...document.querySelectorAll('.invoice-record-actions button')].every(button => button.scrollWidth <= button.clientWidth)"), true, `${width}px invoice actions must not clip their labels`);
  }
  await read("document.querySelector('[data-edit-invoice]').click(); true");
  await until("!document.querySelector('#editorPage').hidden && document.querySelector('#syncStatus').dataset.state==='synced'");
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await read("document.querySelector('#billTo').value='OFFLINE EDIT'; document.querySelector('#billTo').dispatchEvent(new Event('input',{bubbles:true})); true");
  await until("document.querySelector('#syncStatus').textContent.includes('Waiting to sync')");
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until("document.querySelector('#syncStatus').dataset.state==='synced'");
  await read("location.reload(); true");
  await until("!document.querySelector('#draftNotice').hidden && !document.querySelector('#invoiceListPage').hidden");
  await read("document.querySelector('#continueDraftButton').click(); true");
  assert.equal(await read("document.querySelector('#billTo').value"), "OFFLINE EDIT");
  await read(`(() => {
    const saveDraft = window.invoiceBackend.saveDraft;
    const saveInvoice = window.invoiceBackend.saveInvoice;
    window.invoiceSaveCalls = 0;
    window.invoiceBackend.saveInvoice = (...args) => { window.invoiceSaveCalls += 1; return saveInvoice(...args); };
    window.invoiceBackend.saveDraft = (...args) => {
      window.invoiceBackend.saveDraft = saveDraft;
      throw Object.assign(new Error('Draft changed on another device'), { code: 'DRAFT_REVISION_CONFLICT' });
    };
    document.querySelector('#printButton').click();
  })()`);
  await until("document.querySelector('#draftConflictDialog').open");
  await read("document.querySelector('#keepCloudDraftButton').click(); true");
  await until("!document.querySelector('#printButton').disabled");
  assert.equal(await read("window.invoiceSaveCalls"), 0, "resolving a draft conflict must not commit the stale invoice snapshot");
  assert.equal(await read("document.querySelector('#outputDialog').open"), false);
  await read("document.querySelector('#printButton').click(); true");
  await until("document.querySelector('#outputDialog').open && document.querySelector('#outputDialog').getAttribute('aria-busy')!=='true'");
  await read("document.querySelector('#cancelOutputDialogButton').click(); document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden && document.querySelector('#accountControls').hidden");
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(`other-${email}`)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  assert.equal(await read("document.querySelectorAll('.invoice-record').length"), 0);
  assert.equal(await read("document.querySelector('#draftNotice').hidden"), true);
  assert.equal(await read("document.querySelector('#billTo').value"), "");
  assert.deepEqual(exceptions, []);
});

test("Google popup sign-in preserves local invoices on cancellation, imports them, and reopens the same private account", { timeout: 90000 }, async (context) => {
  const { page, read, until, socket, exceptions } = await launchFirebaseBrowser(context);
  const browser = await connectCdp(socket);
  context.after(() => browser.close());
  const targetsUrl = `http://127.0.0.1:${new URL(socket).port}/json/list`;
  const clickGoogle = () => page.send("Runtime.evaluate", {
    expression: "document.querySelector('#googleSignInButton').click()", userGesture: true,
  });
  const popupTarget = () => waitFor(async () => {
    const targets = await (await fetch(targetsUrl)).json();
    return targets.find((target) => target.type === "page" && target.url.startsWith(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/auth/handler`));
  }, 15000);
  async function chooseGoogle(email, reuse = false) {
    await clickGoogle();
    const target = await popupTarget();
    const url = new URL(target.url);
    assert.equal(url.searchParams.get("providerId"), "google.com");
    assert.equal(JSON.parse(url.searchParams.get("customParameters")).prompt, "select_account");
    const popup = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await waitFor(() => evaluate(popup, "document.readyState === 'complete' && Boolean(document.querySelector('.js-new-account'))"), 15000);
      if (reuse) {
        assert.equal(await evaluate(popup, `(() => {
          const account = [...document.querySelectorAll('.js-reuse-account')].find(el => JSON.parse(decodeURIComponent(el.dataset.idToken)).email === ${JSON.stringify(email)});
          if (!account) return false;
          account.click(); return true;
        })()`), true);
      } else {
        await evaluate(popup, `(() => {
          document.querySelector('.js-new-account').click();
          const input = document.querySelector('#email-input');
          input.value = ${JSON.stringify(email)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#main-form').requestSubmit();
        })()`);
      }
    } finally { popup.close(); }
  }
  const email = `google-${Date.now()}@gmail.com`;
  const invoice = {
    invoiceNumber: "EHR-20260915-007", pdfFileName: "EHR-20260915-007",
    invoiceDate: "2026-09-15", dueDate: "2026-09-22", billTo: "DEVICE CUSTOMER",
    items: [{ id: "google-item", quantity: 1, description: "Monthly rental", price: 250 }],
  };
  await read(`localStorage.setItem('invoice-studio-history-v1', JSON.stringify([{id:'google-device-invoice', invoice:${JSON.stringify(invoice)}}]));
    localStorage.setItem('invoice-studio-draft-v1', JSON.stringify(${JSON.stringify(invoice)}));
    localStorage.setItem('invoice-studio-sequence-v1', JSON.stringify({date:'20260915', sequence:7}));
    window.originalOpen = window.open; window.open = () => null; true`);
  await clickGoogle();
  await until("document.querySelector('#authMessage').textContent.includes('blocked') && !document.querySelector('#googleSignInButton').disabled");
  assert.equal(await read("Boolean(localStorage.getItem('invoice-studio-history-v1'))"), true);
  assert.equal(await read("window.invoiceBackend.getSession()"), null);
  await read("window.open = window.originalOpen; true");

  await clickGoogle();
  const cancelled = await popupTarget();
  assert.equal(await read("document.querySelector('#signInButton').disabled && document.querySelector('#createAccountButton').disabled"), true);
  await browser.send("Target.closeTarget", { targetId: cancelled.id });
  await until("document.querySelector('#authMessage').textContent.includes('cancelled') && !document.querySelector('#googleSignInButton').disabled");
  assert.equal(await read("Boolean(localStorage.getItem('invoice-studio-history-v1'))"), true);
  assert.equal(await read("window.invoiceBackend.getSession()"), null);

  await chooseGoogle(email);
  await until("document.querySelector('#legacyMigrationDialog').open");
  assert.equal(await read("document.querySelector('#legacyMigrationDestination').textContent"), email);
  assert.equal(await read("Boolean(localStorage.getItem('invoice-studio-history-v1'))"), true, "Google login alone must not remove local invoices");
  await read("document.querySelector('#moveLegacyDataButton').click(); true");
  await until("!document.querySelector('#invoiceListPage').hidden && document.querySelectorAll('.invoice-record').length === 1");
  const uid = await read("window.invoiceBackend.getSession().then(session => session.user.id)");
  assert.equal(await read("localStorage.getItem('invoice-studio-history-v1')"), null);
  assert.equal(await read("localStorage.getItem('invoice-studio-draft-v1')"), null);
  assert.equal(await read("window.invoiceBackend.nextInvoiceNumber('2026-09-15')"), "EHR-20260915-008");
  assert.equal(await read("document.querySelector('#draftNotice').hidden"), false);
  await read("window.__googleReloadMarker = true; location.reload(); true");
  await until("typeof window.__googleReloadMarker === 'undefined' && !document.querySelector('#invoiceListPage').hidden && document.querySelectorAll('.invoice-record').length === 1");
  assert.equal(await read("window.invoiceBackend.getSession().then(session => session.user.id)"), uid);

  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden && !document.querySelector('#googleSignInButton').disabled");
  await chooseGoogle(email, true);
  await until("!document.querySelector('#invoiceListPage').hidden && document.querySelectorAll('.invoice-record').length === 1");
  assert.equal(await read("window.invoiceBackend.getSession().then(session => session.user.id)"), uid);
  assert.match(await read("document.querySelector('.invoice-customer').textContent"), /DEVICE CUSTOMER/);

  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden && !document.querySelector('#googleSignInButton').disabled");
  await chooseGoogle(`other-${email}`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  assert.notEqual(await read("window.invoiceBackend.getSession().then(session => session.user.id)"), uid);
  assert.equal(await read("document.querySelectorAll('.invoice-record').length"), 0);
  assert.equal(await read("document.querySelector('#draftNotice').hidden"), true);
  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden && !document.querySelector('#googleSignInButton').disabled");
  const existingEmail = `existing-${email}`;
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(existingEmail)}; document.querySelector('#authPassword').value='Existing-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  const existingUid = await read("window.invoiceBackend.getSession().then(session => session.user.id)");
  await read(`window.invoiceBackend.saveInvoice(${JSON.stringify(existingUid)}, {id:'existing-email-invoice', invoice:${JSON.stringify(invoice)}})`);
  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden && !document.querySelector('#googleSignInButton').disabled");
  await chooseGoogle(existingEmail);
  await until("!document.querySelector('#invoiceListPage').hidden && document.querySelectorAll('.invoice-record').length === 1");
  assert.equal(await read("window.invoiceBackend.getSession().then(session => session.user.id)"), existingUid, "Google must keep the existing Gmail account's UID and invoices");
  assert.deepEqual(exceptions, []);
});

test("saving an invoice uploads its real PDF, reports upload failure honestly, and retries the exact locally downloadable copy", { timeout: 90000 }, async (context) => {
  const { read, until, socket, profile, exceptions } = await launchFirebaseBrowser(context);
  const browser = await connectCdp(socket);
  context.after(() => browser.close());
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: profile });
  const email = `pdf-browser-${Date.now()}@example.test`;
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  assert.equal(await read("window.invoiceBackend.pdfStorageAvailable"), true);
  await read(`(() => {
    const upload = window.invoiceBackend.saveInvoicePdf;
    window.pdfUploadCalls = 0;
    window.invoiceBackend.saveInvoicePdf = async (...args) => {
      window.pdfUploadCalls += 1;
      if (window.pdfUploadCalls === 1) {
        await new Promise((resolve, reject) => { window.failFirstPdfUpload = () => reject(Object.assign(new Error('Simulated connection failure'), { code: 'storage/retry-limit-exceeded' })); });
      }
      return upload(...args);
    };
    document.querySelector('#historyNewInvoiceButton').click();
  })()`);
  await until("!document.querySelector('#editorPage').hidden");
  await read(`(() => {
    const set = (selector, value) => { const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); };
    set('#billTo','CLOUD PDF AUDIT CUSTOMER');
    set('[data-item-field="description"]','Private PDF storage audit');
    set('[data-item-field="price"]','125');
    document.querySelector('#printButton').click();
  })()`);
  await until("typeof window.failFirstPdfUpload==='function'");
  assert.equal(await read("document.querySelector('#invoiceForm').inert && document.querySelector('#signOutButton').disabled && document.querySelector('#cancelOutputDialogButton').disabled"), true);
  assert.equal(await read("document.querySelector('#cloudPdfStatus').dataset.state"), "saving");
  await read("window.failFirstPdfUpload(); true");
  await until("document.querySelector('#cloudPdfStatus').dataset.state==='error' && !document.querySelector('#savePdfButton').disabled");
  assert.match(await read("document.querySelector('#cloudPdfStatus').textContent"), /Invoice details saved. We couldn't confirm that the PDF was saved to your account/);
  const saved = await read(`(async () => {
    const uid=(await window.invoiceBackend.getSession()).user.id;
    const result=await window.invoiceBackend.listInvoices(uid);
    return {uid, record:result.records[0], total:result.total};
  })()`);
  assert.equal(saved.total, 1, "PDF upload failure must not lose the saved invoice");
  assert.equal(await read(`window.invoiceBackend.loadInvoicePdf(${JSON.stringify(saved.uid)},${JSON.stringify(saved.record)}).then(()=>false,error=>error.code)`), "storage/object-not-found");
  const fileName = await read("document.querySelector('#outputFileName').textContent");
  const filePath = join(profile, fileName);
  await read("document.querySelector('#savePdfButton').click(); true");
  await waitFor(async () => { try { return (await stat(filePath)).size > 20000; } catch { return false; } }, 20000);
  await until("!document.querySelector('#savePdfButton').disabled");
  const localPdf = await readFile(filePath);
  assert.equal(localPdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal((localPdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1);
  assert.match(localPdf.toString("latin1"), /CLOUD PDF AUDIT CUSTOMER/);
  assert.equal(await read("document.querySelector('#outputDialog').open"), true, "downloading locally keeps the unresolved cloud status visible");
  assert.equal(await read("document.querySelector('#cloudPdfStatus').dataset.state"), "error");
  assert.match(await read("document.querySelector('#toast').textContent"), /downloaded to this device/);
  await read("document.querySelector('#retryCloudPdfButton').click(); true");
  await until("document.querySelector('#cloudPdfStatus').dataset.state==='saved' && !document.querySelector('#cancelOutputDialogButton').disabled");
  assert.equal(await read("window.pdfUploadCalls"), 2);
  assert.equal(await read("document.querySelector('#cloudPdfStatus').textContent"), "PDF saved to your account.");
  await read("document.querySelector('#cancelOutputDialogButton').click(); location.reload(); true");
  await until("!document.querySelector('#invoiceListPage').hidden && document.querySelectorAll('.invoice-record').length===1");
  const cloudPdf = await read(`(async () => {
    const blob=await window.invoiceBackend.loadInvoicePdf(${JSON.stringify(saved.uid)},${JSON.stringify(saved.record)});
    const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return {type:blob.type,size:blob.size,header:await blob.slice(0,5).text(),sha256:Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')};
  })()`);
  assert.equal(cloudPdf.type, "application/pdf");
  assert.equal(cloudPdf.header, "%PDF-");
  assert.equal(cloudPdf.size, localPdf.length);
  assert.equal(cloudPdf.sha256, createHash("sha256").update(localPdf).digest("hex"), "Storage must retain the exact generated PDF bytes after reload");
  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden");
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#signInButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden && Boolean(document.querySelector('[data-download-invoice-pdf]'))");
  await rm(filePath);
  await read("document.querySelector('[data-download-invoice-pdf]').click(); true");
  await waitFor(async () => { try { return (await stat(filePath)).size === localPdf.length; } catch { return false; } }, 20000);
  assert.deepEqual(await readFile(filePath), localPdf, "history download after signing in must use the stored original PDF");
  assert.match(await read("document.querySelector('#toast').textContent"), /downloaded from your account/);
  await read(`(async () => {
    await window.invoiceBackend.saveInvoice(${JSON.stringify(saved.uid)}, {id:'old-import-without-pdf',invoice:${JSON.stringify(saved.record.invoice)}});
    document.querySelector('#refreshInvoicesButton').click();
  })()`);
  await until("document.querySelectorAll('.invoice-record').length===2");
  await read("document.querySelector('[data-download-invoice-pdf=\"old-import-without-pdf\"]').click(); true");
  await until("document.querySelector('#toast').textContent.includes('No PDF has been saved for this invoice yet')");
  await rm(filePath);
  await read(`(() => {
    const load=window.invoiceBackend.loadInvoicePdf;
    window.invoiceBackend.loadInvoicePdf=async (...args) => {
      const blob=await load(...args);
      return new Promise(resolve => { window.releasePendingPdfDownload=() => { resolve(blob); window.pdfDownloadReleased=true; }; });
    };
    document.querySelector('[data-download-invoice-pdf="${saved.record.id}"]').click();
  })()`);
  await until("typeof window.releasePendingPdfDownload==='function'");
  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden");
  await read("window.releasePendingPdfDownload(); true");
  await until("window.pdfDownloadReleased && document.querySelector('#accountControls').hidden");
  await assert.rejects(stat(filePath), { code: "ENOENT" }, "a late PDF response must not download after sign-out");
  assert.equal(await read("document.querySelector('#cloudPdfPanel').hidden"), true);
  assert.deepEqual(exceptions, []);
});

test("an already stored PDF is the exact copy used by Save as PDF and invoice history", { timeout: 90000 }, async (context) => {
  const { read, until, socket, profile, exceptions } = await launchFirebaseBrowser(context);
  const browser = await connectCdp(socket);
  context.after(() => browser.close());
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: profile });
  const email = `pdf-existing-${Date.now()}@example.test`;
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  await read(`(() => {
    const upload = window.invoiceBackend.saveInvoicePdf;
    window.invoiceBackend.saveInvoicePdf = async (uid, record, blob) => {
      // Simulate another renderer saving this revision first. A trailing PDF
      // comment preserves its appearance while making its bytes distinct.
      const original = new Blob([blob, '\\n% Previously stored copy\\n'], {type:'application/pdf'});
      try {
        await upload(uid, record, original);
        const result = await upload(uid, record, blob);
        window.reusedStoredPdf = result.alreadySaved;
        return result;
      } catch (error) {
        window.existingPdfError = {code:error.code,message:error.message};
        throw error;
      }
    };
    document.querySelector('#historyNewInvoiceButton').click();
  })()`);
  await until("!document.querySelector('#editorPage').hidden");
  await read(`(() => {
    const set = (selector, value) => { const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); };
    set('#invoiceNumber','PDF-EXISTING-COPY');
    set('#billTo','STORED PDF EQUALITY TEST');
    set('[data-item-field="description"]','Previously saved invoice PDF');
    set('[data-item-field="price"]','1');
    document.querySelector('#printButton').click();
  })()`);
  await until("['saved','error'].includes(document.querySelector('#cloudPdfStatus').dataset.state) && !document.querySelector('#savePdfButton').disabled");
  assert.equal(await read("document.querySelector('#cloudPdfStatus').dataset.state"), "saved", JSON.stringify(await read("window.existingPdfError")));
  assert.equal(await read("window.reusedStoredPdf"), true);
  const cloud = await read(`(async () => {
    const uid=(await window.invoiceBackend.getSession()).user.id;
    const {records}=await window.invoiceBackend.listInvoices(uid);
    const blob=await window.invoiceBackend.loadInvoicePdf(uid,records[0]);
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return {size:blob.size,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
  })()`);
  const filePath = join(profile, "PDF-EXISTING-COPY.pdf");
  await read("document.querySelector('#savePdfButton').click(); true");
  await waitFor(async () => { try { return (await stat(filePath)).size > 1000; } catch { return false; } }, 20000);
  const downloaded = await readFile(filePath);
  assert.equal(createHash("sha256").update(downloaded).digest("hex"), cloud.sha256, "Save as PDF must use the stored file when Firebase reuses an existing revision");
  assert.equal(downloaded.length, cloud.size);
  await rm(filePath);
  await read("location.reload(); true");
  await until("!document.querySelector('#invoiceListPage').hidden && Boolean(document.querySelector('[data-download-invoice-pdf]'))");
  await read("document.querySelector('[data-download-invoice-pdf]').click(); true");
  await waitFor(async () => { try { return (await stat(filePath)).size === cloud.size; } catch { return false; } }, 20000);
  assert.deepEqual(await readFile(filePath), downloaded, "history and immediate downloads must be byte-identical");
  assert.deepEqual(exceptions, []);
});

test("a new draft edit following an overlapping successful sync uses the new revision", { timeout: 45000 }, async (context) => {
  const { read, until, exceptions } = await launchFirebaseBrowser(context);
  const email = `draft-race-${Date.now()}@example.test`;
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  await read("document.querySelector('#historyNewInvoiceButton').click(); true");
  await until("!document.querySelector('#editorPage').hidden");
  await read(`(() => {
    const save=window.invoiceBackend.saveDraft;
    let first=true;
    window.invoiceBackend.saveDraft=async (...args) => {
      const saved=await save(...args);
      if (first) { first=false; await new Promise(resolve=>{window.releaseFirstDraftSync=resolve;}); }
      return saved;
    };
    const input=document.querySelector('#billTo');
    input.value='FIRST EDIT'; input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until("typeof window.releaseFirstDraftSync==='function'");
  await read("document.querySelector('#billTo').value='SECOND EDIT'; document.querySelector('#billTo').dispatchEvent(new Event('input',{bubbles:true})); true");
  await until("window.invoiceBackend.getSession().then(session=>window.invoiceDraftOutbox.get(session.user.id)).then(operation=>operation?.invoice?.billTo==='SECOND EDIT')");
  await read(`(() => {
    window.followingDraftSync=flushDraftOutbox().then(async () => {
      const input=document.querySelector('#billTo');
      input.value='THIRD EDIT'; input.dispatchEvent(new Event('input',{bubbles:true}));
      await persistDraftImmediately();
      window.followingDraftSyncDone=true;
    });
    window.releaseFirstDraftSync();
  })()`);
  await until("window.followingDraftSyncDone && document.querySelector('#syncStatus').dataset.state==='synced'");
  assert.equal(await read("document.querySelector('#draftConflictDialog').open"), false);
  assert.equal(await read("window.invoiceBackend.getSession().then(session=>window.invoiceBackend.loadDraft(session.user.id)).then(record=>record.invoice.billTo)"), "THIRD EDIT");
  await read("document.querySelector('#signOutButton').click(); true");
  await until("!document.querySelector('#authPage').hidden");
  assert.deepEqual(exceptions, []);
});

test("sign-out cancels late local PDF download and print even when cloud PDF storage is unavailable", { timeout: 45000 }, async (context) => {
  const { read, until, exceptions } = await launchFirebaseBrowser(context);
  const email = `pdf-session-${Date.now()}@example.test`;
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#createAccountButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden");
  await read("window.invoiceBackend.pdfStorageAvailable=false; document.querySelector('#historyNewInvoiceButton').click(); true");
  await until("!document.querySelector('#editorPage').hidden");
  await read(`(() => {
    const set=(selector,value)=>{const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
    set('#billTo','PRIVATE LOCAL PDF');
    set('[data-item-field="description"]','Session guard audit');
    set('[data-item-field="price"]','1');
    document.querySelector('#printButton').click();
  })()`);
  await until("document.querySelector('#outputDialog').open");
  await read(`(() => {
    window.localPdfDownloads=0;
    window.downloadPdfBlob=()=>{window.localPdfDownloads+=1;};
    window.createInvoicePdfWorker=async () => ({
      worker:{
        save:async()=>{window.localPdfDownloads+=1;},
        outputPdf:()=>new Promise(resolve=>{
          window.releaseLocalPdf=()=>resolve(new Blob(['%PDF-test'],{type:'application/pdf'}));
        }).then(blob=>{window.localPdfReady=true;return blob;}),
      },
      pdfFileName:'private.pdf',
    });
    document.querySelector('#savePdfButton').click();
  })()`);
  await until("typeof window.releaseLocalPdf==='function'");
  await read("window.invoiceBackend.signOut()");
  await until("!document.querySelector('#authPage').hidden");
  await read("window.releaseLocalPdf(); true");
  await until("window.localPdfReady");
  assert.equal(await read("window.localPdfDownloads"), 0);
  assert.equal(await read("document.querySelector('#outputDialog').getAttribute('aria-busy')"), "false");
  await read(`document.querySelector('#authEmail').value=${JSON.stringify(email)}; document.querySelector('#authPassword').value='Browser-test-123!'; document.querySelector('#signInButton').click(); true`);
  await until("!document.querySelector('#invoiceListPage').hidden && Boolean(document.querySelector('[data-edit-invoice]'))");
  await read("document.querySelector('[data-edit-invoice]').click(); true");
  await until("!document.querySelector('#editorPage').hidden");
  await read("document.querySelector('#printButton').click(); true");
  await until("document.querySelector('#outputDialog').open");
  await read(`(() => {
    window.localPdfReady=false;
    window.releaseLocalPdf=undefined;
    window.privatePrintTarget={
      closed:false,replacements:0,
      document:{title:'',body:{textContent:'',style:{cssText:''}}},
      location:{replace(){window.privatePrintTarget.replacements+=1;}},
      close(){this.closed=true;},addEventListener(){},
    };
    window.open=()=>window.privatePrintTarget;
    document.querySelector('#printNowButton').click();
  })()`);
  await until("typeof window.releaseLocalPdf==='function'");
  await read("window.invoiceBackend.signOut()");
  await until("!document.querySelector('#authPage').hidden");
  await read("window.releaseLocalPdf(); true");
  await until("window.localPdfReady && window.privatePrintTarget.closed");
  assert.equal(await read("window.privatePrintTarget.replacements"), 0);
  assert.deepEqual(exceptions, []);
});
