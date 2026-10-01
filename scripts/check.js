// Read-only check: reports which platforms are configured and whether their credentials work.
import { loadEnv } from "../src/util.js";
import * as linkedin from "../src/linkedin.js";
import * as meta from "../src/meta.js";
import { configuredPlatforms } from "../src/publish.js";

loadEnv();
const ready = configuredPlatforms();
const probes = {
  linkedin: async () => `posts as ${await linkedin.resolveAuthor()}`,
  facebook: async () => `page "${(await meta.graph("GET", process.env.FACEBOOK_PAGE_ID, { params: { fields: "name" } })).name}"`,
  instagram: async () => `account @${(await meta.graph("GET", await meta.igId(), { params: { fields: "username" } })).username}`,
};
let failed = false;
for (const [name, probe] of Object.entries(probes)) {
  if (!ready.includes(name)) {
    console.log(`-  ${name}: not configured`);
    continue;
  }
  try {
    console.log(`OK ${name}: ${await probe()}`);
  } catch (e) {
    failed = true;
    console.log(`!! ${name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
