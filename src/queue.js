import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, env } from "./util.js";
import { publish } from "./publish.js";

const file = () => path.join(dataDir(), "queue.json");
const lockFile = () => path.join(dataDir(), "queue.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Several copies of this server can run at once (Claude Code, Claude Desktop, the background job),
// so every read-modify-write of the queue happens under a lock file.
async function withLock(fn) {
  const lock = lockFile();
  for (let i = 0; ; i++) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 30_000) fs.rmSync(lock, { force: true }); // left behind by a crashed process
      else if (i > 100) throw new Error("The schedule queue is locked by another process. Try again.");
      else await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return [];
  }
}

function write(items) {
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export const list = () => read();

export function add(sendAt, payload) {
  return withLock(() => {
    const item = { id: crypto.randomBytes(4).toString("hex"), status: "pending", sendAt, createdAt: new Date().toISOString(), payload };
    write([...read(), item]);
    return item;
  });
}

export function cancel(id) {
  return withLock(() => {
    const items = read();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`No scheduled post with id ${id}.`);
    if (item.status !== "pending") throw new Error(`Post ${id} is ${item.status} and can no longer be cancelled.`);
    item.status = "cancelled";
    write(items);
    return item;
  });
}

// A post that could not go out on time (computer off, no job running) is still sent if it is less than this late.
const maxLateMs = () => Number(env("SOCIAL_MCP_MAX_LATE_MINUTES") || 720) * 60_000;

/**
 * Send every post that is due. Each one is claimed under the lock before sending, so two
 * processes never send the same post. A claimed post is never retried automatically:
 * a second attempt after an unclear failure could publish it twice.
 */
export async function runDue() {
  const claimed = await withLock(() => {
    const items = read();
    const now = Date.now();
    const mine = [];
    for (const item of items) {
      if (item.status === "sending" && now - Date.parse(item.claimedAt) > 15 * 60_000) {
        item.status = "failed";
        item.error = "Interrupted while sending. Check the platforms before posting it again.";
      }
      if (item.status !== "pending" || Date.parse(item.sendAt) > now) continue;
      if (now - Date.parse(item.sendAt) > maxLateMs()) {
        item.status = "missed";
        item.error = "Not sent: nothing was running at the scheduled time and it is now too late.";
        continue;
      }
      item.status = "sending";
      item.claimedAt = new Date().toISOString();
      mine.push(item.id);
    }
    write(items);
    return mine.map((id) => items.find((i) => i.id === id));
  });

  const done = [];
  for (const item of claimed) {
    const results = await publish(item.payload).catch((e) => [{ ok: false, error: e.message }]);
    const ok = results.filter((r) => r.ok).length;
    const status = ok === results.length ? "sent" : ok ? "partial" : "failed";
    await withLock(() => {
      const items = read();
      Object.assign(items.find((i) => i.id === item.id) || {}, { status, results, sentAt: new Date().toISOString() });
      write(items);
    });
    done.push({ id: item.id, status, results });
  }
  return done;
}

/** Check the queue every 30 seconds for as long as this process lives. */
export function startTicker() {
  const tick = () => runDue().catch(() => {});
  setTimeout(tick, 3000).unref();
  setInterval(tick, 30_000).unref();
}
