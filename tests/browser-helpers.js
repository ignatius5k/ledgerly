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

function startServer() {
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
      response.end(await readFile(filePath));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    // Offline coverage must remove the origin, including sockets Chrome opened
    // speculatively or left mid-request. Graceful close waits for those clients.
    server.closeAllConnections();
  });
}

function connectCdp(url, options = {}) {
  const socket = new WebSocket(url);
  const timeoutMs = options.timeoutMs || 20000;
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
    if (!callback) return; // A response can arrive after its request deadline.
    pending.delete(message.id);
    clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  return new Promise((resolve, reject) => {
    const connectionTimer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP connection timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const disconnected = (error) => {
      clearTimeout(connectionTimer);
      reject(error);
      for (const callback of pending.values()) {
        clearTimeout(callback.timer);
        callback.reject(error);
      }
      pending.clear();
    };
    socket.addEventListener("error", () => disconnected(new Error("CDP connection failed.")), { once: true });
    socket.addEventListener("close", () => disconnected(new Error("CDP connection closed before the browser command completed.")), { once: true });
    socket.addEventListener("open", () => {
      clearTimeout(connectionTimer);
      resolve({
        close: () => socket.close(),
        on(method, listener) {
          const methodListeners = listeners.get(method) || [];
          methodListeners.push(listener);
          listeners.set(method, methodListeners);
        },
        send(method, params = {}, commandTimeoutMs = timeoutMs) {
          const id = ++nextId;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(Object.assign(new Error(`CDP ${method} timed out after ${commandTimeoutMs}ms.`), { code: "CDP_TIMEOUT" }));
            }, commandTimeoutMs);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
            try { socket.send(JSON.stringify({ id, method, params })); }
            catch (error) {
              clearTimeout(timer);
              pending.delete(id);
              rejectCommand(error);
            }
          });
        },
      });
    }, { once: true });
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
  try {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } catch (error) {
    if (error.code !== "CDP_TIMEOUT") throw error;
    const state = await cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify({url:location.href,page:document.body?.dataset.page,content:document.body?.innerText?.slice(0,5000)})",
      returnByValue: true,
    }, 2000).then((result) => result.result.value).catch(() => "Browser did not respond to diagnostics.");
    throw new Error(`${error.message}\nEvaluation:\n${expression.slice(0,5000)}\nPage state:\n${state}`, { cause: error });
  }
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

module.exports = { startServer, stopServer, connectCdp, waitFor, evaluate, findChromePath };
