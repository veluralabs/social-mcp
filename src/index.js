#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadEnv, registrar, READ, WRITE } from "./util.js";
import * as linkedin from "./linkedin.js";
import * as meta from "./meta.js";
import * as queue from "./queue.js";
import { PLATFORMS, configuredPlatforms, validate, publish } from "./publish.js";

loadEnv();

const server = new McpServer({ name: "velura-social", version: "0.1.0" });
const tool = registrar(server);

linkedin.register(tool);
meta.registerFacebook(tool);
meta.registerInstagram(tool);

// ---------- cross-platform ----------

const post = {
  platforms: z.array(z.enum(PLATFORMS)).min(1).describe("Where to post"),
  text: z.string().optional().describe("Post text, used on every platform unless overridden below"),
  link: z.string().url().optional().describe("URL to share. A preview card on LinkedIn and Facebook; ignored on Instagram, where links are not clickable."),
  images: z.array(z.string()).max(10).optional().describe("Local file paths or https URLs. Instagram accepts only public https URLs of JPEG images."),
  altText: z.string().optional().describe("Alt text for the first image"),
  linkedinText: z.string().max(3000).optional().describe("Different text for LinkedIn"),
  facebookText: z.string().optional().describe("Different text for Facebook"),
  instagramCaption: z.string().max(2200).optional().describe("Different caption for Instagram"),
  linkedinAuthor: z.string().optional().describe('"person", "organization" or a URN. Defaults to the company page when configured.'),
};

tool(
  "social_status",
  "Check which platforms are configured and whether their credentials work. Run this first when something fails.",
  {},
  READ,
  async () => {
    const ready = configuredPlatforms();
    const probe = async (name, fn) => {
      if (!ready.includes(name)) return { configured: false };
      try {
        return { configured: true, ok: true, ...(await fn()) };
      } catch (e) {
        return { configured: true, ok: false, error: e.message };
      }
    };
    return {
      linkedin: await probe("linkedin", async () => ({ person: await linkedin.getPersonUrn(), postsAs: await linkedin.resolveAuthor() })),
      facebook: await probe("facebook", async () => {
        const p = await meta.graph("GET", process.env.FACEBOOK_PAGE_ID, { params: { fields: "name" } });
        return { page: p.name };
      }),
      instagram: await probe("instagram", async () => {
        const a = await meta.graph("GET", await meta.igId(), { params: { fields: "username" } });
        return { account: a.username };
      }),
      scheduledPending: queue.list().filter((i) => i.status === "pending").length,
    };
  }
);

tool(
  "social_cross_post",
  "Publish one post to several platforms now. Checks everything it can before sending; if a platform still fails, the others are posted and the result says which failed. Public and real — confirm the final text, images and platforms with the user first.",
  post,
  WRITE,
  async (a) => {
    const problems = validate(a);
    if (problems.length) throw new Error(`Nothing was posted:\n- ${problems.join("\n- ")}`);
    return publish(a);
  }
);

tool(
  "social_schedule_post",
  "Queue a post to be published later on one or more platforms. The queue is on this computer: posts go out only while this server or the background job (see README) is running. A post that could not be sent on time is still sent up to 12 hours late, then marked missed. For Facebook alone, facebook_create_post with scheduledTime uses Facebook's own scheduler and needs nothing running.",
  { ...post, sendAt: z.string().describe("When to publish, ISO 8601 with a time zone offset, e.g. 2026-10-05T09:30:00+05:30") },
  WRITE,
  async ({ sendAt, ...payload }) => {
    const t = Date.parse(sendAt);
    if (Number.isNaN(t)) throw new Error("sendAt must be an ISO 8601 date-time, e.g. 2026-10-05T09:30:00+05:30.");
    if (t < Date.now() + 30_000) throw new Error("sendAt must be in the future. To post now, use social_cross_post.");
    const problems = validate(payload);
    if (problems.length) throw new Error(`Not scheduled:\n- ${problems.join("\n- ")}`);
    const item = await queue.add(new Date(t).toISOString(), payload);
    return { id: item.id, sendAt: item.sendAt, platforms: payload.platforms };
  }
);

tool(
  "social_list_scheduled",
  "List posts in the local schedule queue with their status: pending, sending, sent, partial, failed, missed or cancelled.",
  { status: z.enum(["pending", "sending", "sent", "partial", "failed", "missed", "cancelled"]).optional().describe("Only this status; default all") },
  READ,
  (a) => queue.list().filter((i) => !a.status || i.status === a.status).sort((x, y) => x.sendAt.localeCompare(y.sendAt))
);

tool("social_cancel_scheduled", "Cancel a pending post in the local schedule queue.", { id: z.string().describe("Queue id from social_schedule_post or social_list_scheduled") }, WRITE, (a) =>
  queue.cancel(a.id)
);

tool("social_run_due", "Send any queued posts that are due right now, without waiting for the next automatic check.", {}, WRITE, async () => {
  const done = await queue.runDue();
  return done.length ? done : "No posts were due.";
});

queue.startTicker();
await server.connect(new StdioServerTransport());
