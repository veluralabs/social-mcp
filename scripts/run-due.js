// Sends queued posts that are due, then exits. Run by the background job every minute.
import { loadEnv } from "../src/util.js";
import { runDue } from "../src/queue.js";

loadEnv();
const done = await runDue();
for (const d of done) console.log(new Date().toISOString(), d.id, d.status, JSON.stringify(d.results));
