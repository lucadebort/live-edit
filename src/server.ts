import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotate,
  applyEdit,
  EditError,
  hashSource,
  type EditOp,
} from "./source.ts";

export interface ServerOptions {
  /** Directory served as the site root. */
  root: string;
  /** Page opened at `/`, relative to root. */
  entry?: string;
  /** File or folder inside root that can be edited. Defaults to root. */
  editable?: string;
  port: number;
  /** CSS selector limiting what can be edited. */
  scope?: string;
  /** Upload folder, relative to the edited page. */
  uploads: string;
}

const CLIENT_SCRIPT = fileURLToPath(
  new URL("./client/editor.js", import.meta.url),
);
const API = "/__live-edit";
const MAX_BACKUPS = 20;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream",
};

const isHtml = (file: string) => /\.html?$/i.test(file);

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function startServer(
  opts: ServerOptions,
): Promise<{ url: string; backups: string }> {
  const root = path.resolve(opts.root);
  const backups = path.join(
    homedir(),
    ".cache",
    "live-edit",
    root.replace(/[^\w.-]+/g, "_"),
  );

  /** Maps a URL path to a file inside root, refusing anything outside it. */
  function resolvePath(urlPath: string): string {
    const decoded = decodeURIComponent(urlPath.split("?")[0]!);
    const file = path.resolve(root, "." + path.posix.normalize("/" + decoded));
    if (file !== root && !file.startsWith(root + path.sep))
      throw new HttpError(403, "Outside root");
    return file;
  }

  const editable = path.resolve(opts.editable ?? root);
  if (editable !== root && !editable.startsWith(root + path.sep))
    throw new Error(`Editable path is outside the served root: ${editable}`);

  const isEditable = (file: string) =>
    isHtml(file) && (file === editable || file.startsWith(editable + path.sep));

  async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max)
        throw new HttpError(
          413,
          `Body too large (max ${max / 1024 / 1024} MB)`,
        );
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function send(
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    type = "text/plain; charset=utf-8",
  ) {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  const json = (res: ServerResponse, status: number, data: unknown) =>
    send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

  async function backup(file: string) {
    const rel = path.relative(root, file);
    const dir = path.join(backups, rel);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(file, path.join(dir, `${stamp}${path.extname(file)}`));
    const old = (await readdir(dir)).sort().slice(0, -MAX_BACKUPS);
    await Promise.all(old.map((name) => unlink(path.join(dir, name))));
  }

  /** Writes go through one queue so two quick edits never interleave. */
  let writeQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => undefined);
    return next;
  };

  async function handleEdit(req: IncomingMessage, res: ServerResponse) {
    const body = JSON.parse(
      (await readBody(req, MAX_JSON_BYTES)).toString("utf8"),
    ) as {
      page: string;
      hash: string;
      op: EditOp;
    };
    const file = resolvePath(body.page);
    if (!isHtml(file))
      throw new HttpError(400, "Only HTML pages can be edited");
    if (!isEditable(file))
      throw new HttpError(403, "This page is not editable");

    const result = await serialized(async () => {
      const source = await readFile(file, "utf8");
      if (hashSource(source) !== body.hash) {
        throw new HttpError(409, "The file changed on disk. Reload the page.");
      }
      const edit = applyEdit(source, body.op);
      await backup(file);
      const tmp = `${file}.live-edit.tmp`;
      await writeFile(tmp, edit.source, "utf8");
      await rename(tmp, file);
      return {
        hash: hashSource(edit.source),
        oldCount: edit.oldCount,
        newCount: edit.newCount,
      };
    });

    console.log(
      `  edited  ${path.relative(root, file)}  (#${body.op.id}, ${body.op.type})`,
    );
    json(res, 200, result);
  }

  async function handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) {
    const page = resolvePath(url.searchParams.get("page") ?? "/");
    if (!isEditable(page))
      throw new HttpError(403, "This page is not editable");
    const rawName = decodeURIComponent(
      String(req.headers["x-filename"] ?? "image"),
    );
    const name =
      path
        .basename(rawName)
        .replace(/[^\w.-]+/g, "_")
        .replace(/^\.+/, "") || "image";
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext))
      throw new HttpError(400, `File type not allowed: ${ext || "none"}`);

    const data = await readBody(req, MAX_UPLOAD_BYTES);
    const dir = path.resolve(path.dirname(page), opts.uploads);
    if (!dir.startsWith(root))
      throw new HttpError(403, "Upload folder outside root");
    await mkdir(dir, { recursive: true });

    // Never overwrite an existing file.
    const stem = path.basename(name, ext);
    let dest = path.join(dir, name);
    for (
      let i = 1;
      await stat(dest).then(
        () => true,
        () => false,
      );
      i++
    ) {
      dest = path.join(dir, `${stem}-${i}${ext}`);
    }
    await writeFile(dest, data);

    const src = path
      .relative(path.dirname(page), dest)
      .split(path.sep)
      .join("/");
    console.log(`  upload  ${path.relative(root, dest)}`);
    json(res, 200, { src });
  }

  async function servePage(res: ServerResponse, file: string, urlPath: string) {
    const source = await readFile(file, "utf8");
    if (!isEditable(file)) return send(res, 200, source, MIME[".html"]);
    const config = JSON.stringify({
      page: urlPath,
      hash: hashSource(source),
      scope: opts.scope ?? null,
    }).replace(/</g, "\\u003c");
    const inject =
      `<script data-live-edit-ui>window.__LIVE_EDIT__=${config}</script>` +
      `<script data-live-edit-ui type="module" src="${API}/editor.js"></script>`;
    const html = annotate(source);
    const at = html.search(/<\/body\s*>(?![\s\S]*<\/body)/i);
    send(
      res,
      200,
      at === -1 ? html + inject : html.slice(0, at) + inject + html.slice(at),
      MIME[".html"],
    );
  }

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) {
    if (url.pathname === "/" && opts.entry) {
      res.writeHead(302, {
        Location:
          "/" + opts.entry.split(path.sep).map(encodeURIComponent).join("/"),
      });
      res.end();
      return;
    }
    let file = resolvePath(url.pathname);
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { Location: url.pathname + "/" });
        res.end();
        return;
      }
      file = path.join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) throw new HttpError(404, "Not found");

    if (isHtml(file))
      return servePage(
        res,
        file,
        url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname,
      );

    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === `${API}/editor.js`) {
        return send(res, 200, await readFile(CLIENT_SCRIPT), MIME[".js"]);
      }
      if (req.method === "POST" && url.pathname === `${API}/edit`)
        return await handleEdit(req, res);
      if (req.method === "POST" && url.pathname === `${API}/upload`)
        return await handleUpload(req, res, url);
      if (req.method === "GET" || req.method === "HEAD")
        return await serveStatic(req, res, url);
      throw new HttpError(405, "Method not allowed");
    } catch (err) {
      const status =
        err instanceof HttpError || err instanceof EditError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(err);
      if (!res.headersSent) send(res, status, message);
    }
  });

  return new Promise((resolve, reject) => {
    const listen = (port: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < opts.port + 20)
          listen(port + 1);
        else reject(err);
      });
      // Loopback only: this server writes to disk.
      server.listen(port, "127.0.0.1", () =>
        resolve({ url: `http://localhost:${port}/`, backups }),
      );
    };
    listen(opts.port);
  });
}
