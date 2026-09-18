"use strict";

const { cp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { dirname, join, relative, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, process.env.BUILD_OUTPUT_DIR || "dist");
const STATIC_FILES = [
  "index.html",
  "styles.css",
  "redesign.css",
  "app.js",
  "backend.js",
  "firebase-config.js",
  "vendor/firebase-client.js",
  "outbox.js",
  "sw.js",
  "manifest.webmanifest",
  "ledgerly-mark.png",
  "eng-hoon-residences-logo.png",
  "icon-192.png",
  "icon-512.png",
  "vendor/html2pdf.bundle.min.js",
  "vendor/html2pdf.bundle.min.js.LICENSE.txt",
];

function validateOutputDirectory() {
  const relativeOutput = relative(ROOT, OUTPUT);
  if (!relativeOutput || relativeOutput.startsWith("..") || relativeOutput.includes("node_modules")) {
    throw new Error("BUILD_OUTPUT_DIR must be a dedicated directory inside the project.");
  }
}

async function copyStaticFile(relativePath) {
  const destination = join(OUTPUT, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(ROOT, relativePath), destination);
}

async function main() {
  validateOutputDirectory();
  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
  await Promise.all(STATIC_FILES.map(copyStaticFile));

  let firebaseConfig;
  if (process.env.FIREBASE_WEB_CONFIG) {
    firebaseConfig = JSON.parse(process.env.FIREBASE_WEB_CONFIG);
  } else {
    try { firebaseConfig = JSON.parse(await readFile(join(ROOT, "firebase-config.local.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (firebaseConfig) {
    for (const key of ["apiKey", "authDomain", "projectId", "appId"]) {
      if (typeof firebaseConfig[key] !== "string" || !firebaseConfig[key].trim()) throw new Error(`Firebase configuration is missing ${key}.`);
    }
    // Only the public web config belongs in the client, never service account credentials.
    const publicConfig = Object.fromEntries(["apiKey", "authDomain", "projectId", "appId", "storageBucket", "messagingSenderId", "googleClientId"].filter((key) => firebaseConfig[key]).map((key) => [key, firebaseConfig[key]]));
    await writeFile(join(OUTPUT, "firebase-config.js"), `window.INVOICE_FIREBASE_CONFIG = ${JSON.stringify(publicConfig, null, 2)};\n`);
  }

  const headerTemplate = await readFile(join(ROOT, "deployment", "_headers.template"), "utf8");
  await writeFile(join(OUTPUT, "_headers"), headerTemplate, "utf8");

  process.stdout.write(`Built ${relative(ROOT, OUTPUT)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
