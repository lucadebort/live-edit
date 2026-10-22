#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "./server.ts";

const HELP = `
live-edit: edit the text of a static HTML page in the browser, saved to the source file.

Usage
  live-edit [page.html | folder] [options]

Only the given page or folder is editable. With --root, a wider folder is
served around it, so absolute paths like /assets/... keep working.

Options
  -r, --root <dir>     Folder served as the site root (default: the page's folder)
  -p, --port <n>       Port to listen on (default 3000, next free one if taken)
  -s, --scope <css>    Only elements inside this selector are editable (e.g. "main")
  -u, --uploads <dir>  Where replaced images go, relative to the page (default "uploads")
  -o, --open           Open the browser
  -h, --help           Show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", short: "r" },
    port: { type: "string", short: "p", default: "3000" },
    scope: { type: "string", short: "s" },
    uploads: { type: "string", short: "u", default: "uploads" },
    open: { type: "boolean", short: "o", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const target = path.resolve(positionals[0] ?? ".");
const info = await stat(target).catch(() => null);
if (!info) {
  console.error(`Not found: ${target}`);
  process.exit(1);
}

const root = values.root
  ? path.resolve(values.root)
  : info.isDirectory()
    ? target
    : path.dirname(target);
const rel = path.relative(root, target);
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  console.error(`${target} is not inside the root ${root}`);
  process.exit(1);
}
// Folders keep a trailing slash so the redirect lands on their index.html.
const entry = rel ? (info.isDirectory() ? rel + path.sep : rel) : undefined;

const { url, backups } = await startServer({
  root,
  entry,
  editable: target,
  port: Number(values.port),
  scope: values.scope,
  uploads: values.uploads,
});

console.log(`
  live-edit   ${url}
  serving     ${root}${entry ? `\n  editable    ${entry}` : ""}
  backups     ${backups}

  Edit mode: button bottom left, or press E. Ctrl+C to stop.
`);

if (values.open) {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}
