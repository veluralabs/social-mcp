import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env, need, dataDir, loadImage, READ, WRITE, DESTRUCTIVE } from "./util.js";

const API = "https://api.linkedin.com";
const version = () => env("LINKEDIN_VERSION") || "202609";
const HINT = "Set it in the plugin configuration or in .env (see README, Step 1: LinkedIn).";

export const configured = () => !!env("LINKEDIN_ACCESS_TOKEN");

// ---------- auth ----------

const cacheFile = () => path.join(dataDir(), "linkedin-token.json");
let token; // { access_token, expiresAt }

function currentToken() {
  if (!token) {
    try {
      token = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    } catch {}
  }
  // A token refreshed earlier replaces the configured one until it expires.
  if (token && token.expiresAt - 60_000 > Date.now()) return token.access_token;
  return need("LINKEDIN_ACCESS_TOKEN", HINT);
}

// Refresh tokens are only issued to some LinkedIn apps; without one the user re-issues a token every 60 days.
async function refresh() {
  const rt = env("LINKEDIN_REFRESH_TOKEN"), id = env("LINKEDIN_CLIENT_ID"), secret = env("LINKEDIN_CLIENT_SECRET");
  if (!rt || !id || !secret) return null;
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: id, client_secret: secret }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) return null;
  token = { access_token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(token), { mode: 0o600 });
  } catch {}
  return token.access_token;
}

// ---------- http ----------

// Rest.li 2.0: URNs in paths and query values are fully percent-encoded, including ( ) and ,
export const enc = (urn) => encodeURIComponent(urn).replace(/\(/g, "%28").replace(/\)/g, "%29");
const list = (urns) => `List(${urns.map(enc).join(",")})`;

/** Call the LinkedIn API. `query` is a pre-encoded string because Rest.li syntax must not be re-encoded. */
export async function li(method, apiPath, { query, body, headers } = {}) {
  const url = `${apiPath.startsWith("/v2/") ? API : `${API}/rest`}${apiPath}${query ? `?${query}` : ""}`;
  const send = (tok) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        "Linkedin-Version": version(),
        "X-Restli-Protocol-Version": "2.0.0",
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send(currentToken());
  if (res.status === 401) {
    const fresh = await refresh();
    if (fresh) res = await send(fresh);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const why =
      res.status === 401
        ? " The access token is invalid or expired; LinkedIn tokens last 60 days."
        : res.status === 403
          ? " The token lacks the permission (scope) for this call, or you do not have the needed role on the company page."
          : "";
    throw new Error(`LinkedIn API error ${res.status}: ${json.message || json.error_description || text.slice(0, 300)}${why}`);
  }
  return { data: json, id: res.headers.get("x-restli-id") };
}

// ---------- identity ----------

let personUrn;
export async function getPersonUrn() {
  if (personUrn) return personUrn;
  const given = env("LINKEDIN_PERSON_ID");
  if (given) return (personUrn = given.startsWith("urn:") ? given : `urn:li:person:${given}`);
  // OpenID userinfo works with the `openid profile` scopes; /v2/me needs r_liteprofile or r_basicprofile.
  const res = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${currentToken()}` } });
  const info = await res.json().catch(() => ({}));
  if (info.sub) return (personUrn = `urn:li:person:${info.sub}`);
  const me = await li("GET", "/v2/me").catch(() => null);
  if (me?.data?.id) return (personUrn = `urn:li:person:${me.data.id}`);
  throw new Error("Could not determine your LinkedIn member ID. Set LINKEDIN_PERSON_ID, or grant the token the `openid profile` scopes.");
}

const orgUrn = () => {
  const id = env("LINKEDIN_ORGANIZATION_ID");
  return id ? (id.startsWith("urn:") ? id : `urn:li:organization:${id}`) : undefined;
};

/** "person" | "organization" | a full URN -> author URN. Default: LINKEDIN_DEFAULT_AUTHOR, else the company page if configured. */
export async function resolveAuthor(author) {
  const a = author || env("LINKEDIN_DEFAULT_AUTHOR") || (orgUrn() ? "organization" : "person");
  if (a.startsWith("urn:li:")) return a;
  if (a === "organization") {
    const urn = orgUrn();
    if (!urn) throw new Error("No company page configured. Set LINKEDIN_ORGANIZATION_ID, or post with author \"person\".");
    return urn;
  }
  return getPersonUrn();
}

// ---------- posts ----------

// `commentary` uses LinkedIn's "little text" format: these characters are syntax and truncate the post if left bare.
// Mentions written as @[Name](urn:li:...) are kept; # and @ are left alone so hashtags work.
export function escapeCommentary(text) {
  const mentions = [];
  const held = text.replace(/@\[[^\]]+\]\(urn:li:[^)]+\)/g, (m) => `\u0000${mentions.push(m) - 1}\u0000`);
  return held.replace(/[\\|{}\[\]()<>*_~]/g, "\\$&").replace(/\u0000(\d+)\u0000/g, (_, i) => mentions[i]);
}

export async function uploadImage(src, owner) {
  const img = await loadImage(src);
  const { data } = await li("POST", "/images", {
    query: "action=initializeUpload",
    body: { initializeUploadRequest: { owner } },
  });
  const res = await fetch(data.value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${currentToken()}`, "Content-Type": img.contentType },
    body: img.buffer,
  });
  if (!res.ok) throw new Error(`LinkedIn image upload failed for ${img.name}: HTTP ${res.status}`);
  return data.value.image;
}

// LinkedIn does not scrape links posted through the API, so the preview card must be supplied.
async function linkPreview(url) {
  try {
    const html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; social-mcp)" } })).text();
    const meta = (p) =>
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, "i"))?.[1];
    const unescape = (s) => s?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return {
      title: unescape(meta("og:title") || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()),
      description: unescape(meta("og:description") || meta("description")),
      image: meta("og:image"),
    };
  } catch {
    return {};
  }
}

export const postUrl = (urn) => `https://www.linkedin.com/feed/update/${urn}/`;

/** Publish a post. Images win over a link card: with both, the link is appended to the text. */
export async function createPost({ text = "", author, visibility = "PUBLIC", link, linkTitle, linkDescription, images = [], altTexts = [], reshareOf }) {
  const authorUrn = await resolveAuthor(author);
  let commentary = text;
  let content;

  if (images.length) {
    if (images.length > 20) throw new Error("LinkedIn allows at most 20 images in one post.");
    const ids = [];
    for (const src of images) ids.push(await uploadImage(src, authorUrn));
    content =
      ids.length === 1
        ? { media: { id: ids[0], ...(altTexts[0] && { altText: altTexts[0] }) } }
        : { multiImage: { images: ids.map((id, i) => ({ id, ...(altTexts[i] && { altText: altTexts[i] }) })) } };
    if (link && !commentary.includes(link)) commentary = `${commentary}\n\n${link}`.trim();
  } else if (link) {
    const pv = linkTitle ? {} : await linkPreview(link);
    const thumbnail = pv.image ? await uploadImage(new URL(pv.image, link).href, authorUrn).catch(() => undefined) : undefined;
    const description = linkDescription || pv.description;
    content = {
      article: { source: link, title: linkTitle || pv.title || link, ...(description && { description }), ...(thumbnail && { thumbnail }) },
    };
  }

  const { id } = await li("POST", "/posts", {
    body: {
      author: authorUrn,
      commentary: escapeCommentary(commentary),
      visibility,
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content && { content }),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      ...(reshareOf && { reshareContext: { parent: reshareOf } }),
    },
  });
  return { id, url: postUrl(id), author: authorUrn };
}

// ---------- tools ----------

const postUrn = z.string().regex(/^urn:li:(share|ugcPost|activity):\d+$/, "expected urn:li:share:…, urn:li:ugcPost:… or urn:li:activity:…")
  .describe("Post URN, as returned by linkedin_create_post or linkedin_list_posts");
const authorArg = z.string().optional()
  .describe('Who posts or acts: "person" (your profile), "organization" (the configured company page) or a full urn:li:… URN. Defaults to the company page when one is configured, otherwise your profile.');

export function register(tool) {
  tool(
    "linkedin_get_profile",
    "Show the LinkedIn identity this server posts as: your member URN, the configured company page, and the company pages you hold a role on (needs an organization admin scope).",
    {},
    READ,
    async () => {
      const out = { person: await getPersonUrn().catch((e) => e.message), organization: orgUrn() || null, apiVersion: version() };
      const acls = await li("GET", "/organizationAcls", { query: "q=roleAssignee&state=APPROVED" }).catch((e) => ({ error: e.message }));
      out.pages = acls.error ? acls.error : acls.data.elements.map((e) => ({ organization: e.organization || e.organizationTarget, role: e.role }));
      return out;
    }
  );

  tool(
    "linkedin_create_post",
    "Publish a LinkedIn post immediately, as your profile or the company page. Supports text, a link preview card, 1-20 images (local paths or URLs) or a reshare. This is public and real — confirm the final text and author with the user first. Hashtags work as #tag; mention with @[Exact Name](urn:li:organization:123).",
    {
      text: z.string().max(3000).describe("Post text (max 3000 characters)"),
      author: authorArg,
      visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).optional().describe("Default PUBLIC. CONNECTIONS applies to personal posts only."),
      link: z.string().url().optional().describe("URL to share as a preview card. Title, description and thumbnail are read from the page unless given."),
      linkTitle: z.string().optional(),
      linkDescription: z.string().optional(),
      images: z.array(z.string()).max(20).optional().describe("Local file paths or https URLs. JPG, PNG or GIF."),
      altTexts: z.array(z.string()).optional().describe("Alt text for each image, in the same order"),
      reshareOf: postUrn.optional().describe("URN of a post to reshare with this text"),
    },
    WRITE,
    (a) => createPost(a)
  );

  tool(
    "linkedin_list_posts",
    "List recent posts by the company page or your profile, newest first. Listing your own profile's posts needs the restricted r_member_social scope; company page posts need r_organization_social.",
    {
      author: authorArg,
      count: z.number().int().min(1).max(100).optional().describe("Default 10"),
      start: z.number().int().min(0).optional().describe("Offset for paging"),
      sortBy: z.enum(["LAST_MODIFIED", "CREATED"]).optional(),
    },
    READ,
    async (a) => {
      const author = await resolveAuthor(a.author);
      const q = `q=author&author=${enc(author)}&count=${a.count || 10}&start=${a.start || 0}&sortBy=${a.sortBy || "CREATED"}`;
      const { data } = await li("GET", "/posts", { query: q, headers: { "X-RestLi-Method": "FINDER" } });
      return data.elements.map((p) => ({ ...p, url: postUrl(p.id) }));
    }
  );

  tool("linkedin_get_post", "Get one LinkedIn post by URN.", { postUrn }, READ, async (a) => {
    const { data } = await li("GET", `/posts/${enc(a.postUrn)}`, { query: "viewContext=AUTHOR" });
    return { ...data, url: postUrl(a.postUrn) };
  });

  tool(
    "linkedin_update_post",
    "Edit the text of an existing LinkedIn post. Only the text can be changed; media and links cannot.",
    { postUrn, text: z.string().max(3000) },
    WRITE,
    async (a) => {
      await li("POST", `/posts/${enc(a.postUrn)}`, {
        headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
        body: { patch: { $set: { commentary: escapeCommentary(a.text) } } },
      });
      return { updated: a.postUrn, url: postUrl(a.postUrn) };
    }
  );

  tool("linkedin_delete_post", "Permanently delete a LinkedIn post. This cannot be undone.", { postUrn }, DESTRUCTIVE, async (a) => {
    await li("DELETE", `/posts/${enc(a.postUrn)}`, { headers: { "X-RestLi-Method": "DELETE" } });
    return { deleted: a.postUrn };
  });

  tool(
    "linkedin_get_post_stats",
    "Get engagement for a LinkedIn post: like and comment counts, and for company page posts also impressions, clicks, shares and engagement rate (needs rw_organization_admin).",
    { postUrn },
    READ,
    async (a) => {
      const out = { post: a.postUrn };
      const social = await li("GET", `/socialActions/${enc(a.postUrn)}`).catch((e) => ({ error: e.message }));
      out.social = social.error || {
        likes: social.data.likesSummary?.totalLikes ?? 0,
        comments: social.data.commentsSummary?.aggregatedTotalComments ?? 0,
        commentsState: social.data.commentsSummary?.commentsState,
      };
      const org = orgUrn();
      if (org && !a.postUrn.includes(":activity:")) {
        const key = a.postUrn.includes(":ugcPost:") ? "ugcPosts" : "shares";
        const q = `q=organizationalEntity&organizationalEntity=${enc(org)}&${key}=${list([a.postUrn])}`;
        const stats = await li("GET", "/organizationalEntityShareStatistics", { query: q }).catch((e) => ({ error: e.message }));
        // Posts with no impressions yet are simply absent from the response.
        out.pageStats = stats.error || stats.data.elements[0]?.totalShareStatistics || "no impressions recorded yet";
      }
      return out;
    }
  );

  tool(
    "linkedin_get_page_stats",
    "Get company page post statistics (impressions, clicks, likes, comments, shares, engagement): lifetime totals, or per day/month for a date range within the last 12 months. Needs rw_organization_admin.",
    {
      since: z.string().optional().describe("Start date, ISO (e.g. 2026-09-01). Omit both dates for lifetime totals."),
      until: z.string().optional().describe("End date, ISO, exclusive. Defaults to now."),
      granularity: z.enum(["DAY", "MONTH"]).optional().describe("Default DAY"),
    },
    READ,
    async (a) => {
      const org = await resolveAuthor("organization");
      let q = `q=organizationalEntity&organizationalEntity=${enc(org)}`;
      if (a.since) {
        const start = Date.parse(a.since), end = a.until ? Date.parse(a.until) : Date.now();
        if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("since/until must be ISO dates.");
        q += `&timeIntervals=(timeRange:(start:${start},end:${end}),timeGranularityType:${a.granularity || "DAY"})`;
      }
      return (await li("GET", "/organizationalEntityShareStatistics", { query: q })).data.elements;
    }
  );

  tool(
    "linkedin_list_comments",
    "List comments on a LinkedIn post, or replies to a comment (pass the comment's commentUrn as target).",
    {
      target: z.string().describe("Post URN, or a commentUrn like urn:li:comment:(urn:li:activity:1,2) to list its replies"),
      count: z.number().int().min(1).max(100).optional(),
      start: z.number().int().min(0).optional(),
    },
    READ,
    async (a) => {
      const { data } = await li("GET", `/socialActions/${enc(a.target)}/comments`, { query: `count=${a.count || 20}&start=${a.start || 0}` });
      return data.elements.map((c) => ({
        id: c.id, commentUrn: c.commentUrn, actor: c.actor, text: c.message?.text, createdAt: c.created?.time,
        likes: c.likesSummary?.totalLikes ?? 0, replies: c.commentsSummary?.aggregatedTotalComments ?? 0, parentComment: c.parentComment,
      }));
    }
  );

  tool(
    "linkedin_create_comment",
    "Comment on a LinkedIn post, or reply to a comment, as your profile or the company page. Public and real — confirm the text with the user first.",
    {
      postUrn,
      text: z.string().max(1250),
      replyTo: z.string().optional().describe("commentUrn of the comment to reply to (from linkedin_list_comments)"),
      author: authorArg,
    },
    WRITE,
    async (a) => {
      const actor = await resolveAuthor(a.author);
      const { data, id } = await li("POST", `/socialActions/${enc(a.replyTo || a.postUrn)}/comments`, {
        body: { actor, object: a.postUrn, message: { text: a.text }, ...(a.replyTo && { parentComment: a.replyTo }) },
      });
      return { id: id || data.id, commentUrn: data.commentUrn, actor };
    }
  );

  tool(
    "linkedin_delete_comment",
    "Permanently delete a comment you or your company page made on a LinkedIn post.",
    { postUrn, commentId: z.string().regex(/^\d+$/).describe("The comment's numeric id"), author: authorArg },
    DESTRUCTIVE,
    async (a) => {
      const actor = await resolveAuthor(a.author);
      await li("DELETE", `/socialActions/${enc(a.postUrn)}/comments/${a.commentId}`, {
        query: actor.includes(":organization") ? `actor=${enc(actor)}` : undefined,
      });
      return { deleted: a.commentId };
    }
  );
}
