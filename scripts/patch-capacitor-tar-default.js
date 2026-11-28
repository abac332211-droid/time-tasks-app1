#!/usr/bin/env node
"use strict";

// Capacitor CLI 6 imports "tar" as a default export. tar 7 keeps the
// extraction API but its CommonJS entry exposes named exports only and marks
// the module as __esModule. Add the expected default interop alias without
// changing the tar API or downgrading its security fixes.
const fs = require("node:fs");

function fail(message) {
  process.stderr.write("[capacitor-tar-interop] " + message + "\n");
  process.exitCode = 1;
}

try {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 20 && nodeMajor < 22) {
    throw new Error("This dependency tree requires Node.js 20 or >=22; detected " + process.versions.node);
  }

  const entry = require.resolve("tar");
  const packageJsonPath = require.resolve("tar/package.json");
  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const major = Number(String(metadata.version || "").split(".")[0]);

  if (major !== 7) {
    throw new Error("Expected the reviewed tar 7.x API; found tar@" + metadata.version);
  }

  const api = require(entry);
  if (!api || typeof api.extract !== "function") {
    throw new Error("tar@" + metadata.version + " does not expose the extract function required by Capacitor CLI 6");
  }

  if (api.default && api.default.extract === api.extract) {
    process.stdout.write("[capacitor-tar-interop] default export already compatible for tar@" + metadata.version + "\n");
  } else {
    const source = fs.readFileSync(entry, "utf8");
    if (!source.includes("__esModule")) {
      throw new Error("Unexpected CommonJS tar module shape; refusing to patch an unreviewed package");
    }
    const marker = "/* timetasks-capacitor-cli-default-interop */";
    if (!source.includes(marker)) {
      fs.appendFileSync(entry, "\n" + marker + "\nmodule.exports.default = module.exports;\n");
    }
    delete require.cache[entry];
    const patched = require(entry);
    if (!patched.default || patched.default.extract !== patched.extract) {
      throw new Error("Could not verify tar default interop after patch");
    }
    process.stdout.write("[capacitor-tar-interop] verified tar@" + metadata.version + " default.extract alias\n");
  }
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}
