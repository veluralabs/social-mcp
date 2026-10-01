import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env from the repo root so agent configs never have to hold secrets.
// Real environment variables win over the file.
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

// Unset plugin options can arrive as "" or as an unsubstituted "${user_config.x}".
export const env = (k) => {
  const v = process.env[k]?.trim();
  return v && !v.startsWith("${") ? v : undefined;
};

export const need = (k, hint) => {
  const v = env(k);
  if (!v) throw new Error(`Missing ${k}. ${hint || `Set it in the plugin configuration or in ${path.join(ROOT, ".env")}.`}`);
  return v;
};

// State (token cache, schedule queue) lives outside the install dir when run as a plugin,
// because the install dir is replaced on update.
export function dataDir() {
  const dir = env("SOCIAL_MCP_DATA_DIR") || process.env.CLAUDE_PLUGIN_DATA || path.join(ROOT, ".data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const expandHome = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
export const isUrl = (s) => /^https?:\/\//i.test(s);

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

/** Read an image from a local path or an http(s) URL. */
export async function loadImage(src) {
  if (isUrl(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not download image ${src}: HTTP ${res.status}`);
    const name = path.basename(new URL(src).pathname) || "image";
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "image/jpeg", name };
  }
  const file = path.resolve(expandHome(src));
  if (!fs.existsSync(file)) throw new Error(`Image not found: ${file}`);
  return {
    buffer: fs.readFileSync(file),
    contentType: MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    name: path.basename(file),
  };
}

export const READ = { readOnlyHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Returns a `tool(name, description, inputSchema, annotations, handler)` registrar for a server. */
export function registrar(server) {
  return (name, description, inputSchema, annotations, handler) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        const out = await handler(args);
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    });
}
