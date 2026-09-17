const { createServer } = require("node:http");
const { readFile, stat } = require("node:fs/promises");
const { extname, join, normalize } = require("node:path");

const ROOT = join(__dirname, "..");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function startServer(options = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      const filePath = normalize(join(ROOT, relativePath));
      if (!filePath.startsWith(ROOT)) throw new Error("Invalid path");
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("Not a file");
      response.setHeader("Content-Type", TYPES[extname(filePath)] || "application/octet-stream");
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      let body = await readFile(filePath);
      if (relativePath === "firebase-config.js") {
        body = options.firebase
          ? 'window.INVOICE_FIREBASE_CONFIG = {apiKey:"fake-emulator-key",projectId:"demo-ledgerly",appId:"browser-test",storageBucket:"demo-ledgerly.firebasestorage.app",authDomain:"demo-ledgerly.firebaseapp.com"}; window.INVOICE_FIREBASE_EMULATORS={auth:9099,firestore:8080,storage:9199};'
          : 'window.INVOICE_FIREBASE_CONFIG = null;';
      }
      if (options.firebase && relativePath === "index.html") {
        body = body.toString()
          .replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:9099 http://127.0.0.1:8080 http://127.0.0.1:9199")
          .replace("frame-src 'self'", "frame-src 'self' http://127.0.0.1:9099");
      }
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const listener of listeners.get(message.method) || []) listener(message.params || {});
      return;
    }
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("open", () => resolve({
      close: () => socket.close(),
      on(method, listener) {
        const methodListeners = listeners.get(method) || [];
        methodListeners.push(listener);
        listeners.set(method, methodListeners);
      },
      send(method, params = {}) {
        const id = ++nextId;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        });
      },
    }), { once: true });
  });
}

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for browser state");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function findChromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next common browser path.
    }
  }
  return undefined;
}

module.exports = { startServer, connectCdp, waitFor, evaluate, findChromePath };
