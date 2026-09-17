"use strict";

const { build } = require("esbuild");
const { resolve } = require("node:path");

build({
  entryPoints: [resolve(__dirname, "../firebase-backend.mjs")],
  outfile: resolve(__dirname, "../vendor/firebase-client.js"),
  bundle: true, minify: true, format: "iife", platform: "browser", target: ["es2020"],
  legalComments: "eof",
}).catch((error) => { console.error(error); process.exitCode = 1; });
