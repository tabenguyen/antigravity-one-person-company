#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version (used as the GitHub Release body),
// after checking that the version matches package.json and has a dated changelog entry.
//
//   node scripts/release-notes.mjs 0.1.0      (a leading "v" is accepted)

import fs from "node:fs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!SEMVER.test(version)) fail(`"${process.argv[2] ?? ""}" is not a SemVer version (expected X.Y.Z or X.Y.Z-rc.N)`);

const pkgVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (pkgVersion !== version) fail(`package.json version is ${pkgVersion}, tag is ${version}`);

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const lines = changelog.split("\n");
const escaped = version.replace(/[.+-]/g, "\\$&");
const start = lines.findIndex((l) => new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`).test(l));
if (start === -1) fail(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" heading`);

let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]: /.test(l)));
if (end === -1) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) fail(`CHANGELOG.md section for ${version} is empty`);

process.stdout.write(`${body}\n`);
