// Writes release/latest.json, the manifest the in-app updater reads, from the signed update
// packages collected for a release.
//
//   node write-latest-json.cjs <release dir> <notes file>
//   env: TAG (e.g. v0.3.0), REPO (owner/name)
//
// The manifest is written only when EVERY platform has a signed package. If any is missing
// (for example the signing key secret is not configured), no manifest is written and stray
// signature files are removed, so users are never offered an update their platform cannot install.
"use strict";
const fs = require("fs");
const path = require("path");

const [dir, notesFile] = process.argv.slice(2);
const tag = process.env.TAG;
const repo = process.env.REPO;
if (!dir || !notesFile || !tag || !repo) {
  console.error("usage: TAG=vX.Y.Z REPO=owner/name node write-latest-json.cjs <release dir> <notes file>");
  process.exit(2);
}

const files = fs.readdirSync(dir);
const pick = (re) => files.find((f) => re.test(f));

// Updater platform key -> the package the updater installs on that platform.
const wanted = {
  "windows-x86_64": pick(/_x64-setup\.exe$/),
  "darwin-aarch64": pick(/_macos-arm64\.app\.tar\.gz$/),
  "darwin-x86_64": pick(/_macos-x64\.app\.tar\.gz$/),
  "linux-x86_64": pick(/_amd64\.AppImage$/),
};

const platforms = {};
const missing = [];
for (const [platform, file] of Object.entries(wanted)) {
  const sig = file && files.includes(file + ".sig") ? file + ".sig" : null;
  if (!file || !sig) {
    missing.push(platform);
    continue;
  }
  platforms[platform] = {
    signature: fs.readFileSync(path.join(dir, sig), "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}`,
  };
}

if (missing.length > 0) {
  console.log(`No signed update package for: ${missing.join(", ")}. Not writing latest.json.`);
  for (const f of files) {
    if (f.endsWith(".sig")) fs.unlinkSync(path.join(dir, f));
  }
  process.exit(0);
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: fs.readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote latest.json for ${Object.keys(platforms).join(", ")}`);
