import { z } from "zod";
import { env, need, isUrl, loadImage, READ, WRITE, DESTRUCTIVE } from "./util.js";

const HINT = "Set it in the plugin configuration or in .env (see README, Step 1: Facebook and Instagram).";
const base = () => `https://graph.facebook.com/${env("META_GRAPH_VERSION") || "v25.0"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const facebookConfigured = () => !!env("META_ACCESS_TOKEN") && !!env("FACEBOOK_PAGE_ID");
export const instagramConfigured = () => !!env("META_ACCESS_TOKEN") && (!!env("INSTAGRAM_ACCOUNT_ID") || !!env("FACEBOOK_PAGE_ID"));

// ---------- http ----------

/**
 * Call the Graph API. GET/DELETE send `params` as the query string; POST sends them as a form,
 * or as multipart when `file` ({ field, buffer, name, contentType }) is given.
 * The token travels in the Authorization header so it never appears in a URL.
 */
export async function graph(method, path, { params = {}, token, file } = {}) {
  const clean = Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])
  );
  let url = `${base()}/${path.replace(/^\//, "")}`;
  let body;
  if (method === "POST") {
    if (file) {
      body = new FormData();
      for (const [k, v] of Object.entries(clean)) body.append(k, v);
      body.append(file.field, new Blob([file.buffer], { type: file.contentType }), file.name);
    } else body = new URLSearchParams(clean);
  } else if (Object.keys(clean).length) url += `?${new URLSearchParams(clean)}`;

  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token || (await pageToken())}` }, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Meta API returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  if (json.error) {
    const e = json.error;
    const why =
      e.code === 190 ? " The access token is invalid or expired." :
      e.code === 10 || e.code === 200 || (e.code >= 200 && e.code < 300) ? " The token is missing a permission for this call." : "";
    throw new Error(`Meta API error ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}: ${e.error_user_msg || e.message}${why}`);
  }
  return json;
}

// ---------- identity ----------

const pageId = () => need("FACEBOOK_PAGE_ID", HINT);

// Page calls need a Page token. Given a user token, exchange it once; given a Page token already, use it as is.
let cachedPageToken;
export async function pageToken() {
  if (cachedPageToken) return cachedPageToken;
  const given = need("META_ACCESS_TOKEN", HINT);
  if (!env("FACEBOOK_PAGE_ID")) return (cachedPageToken = given);
  const res = await fetch(`${base()}/${pageId()}?fields=access_token`, { headers: { Authorization: `Bearer ${given}` } });
  const json = await res.json().catch(() => ({}));
  return (cachedPageToken = json.access_token || given);
}

let cachedIgId;
export async function igId() {
  if (cachedIgId) return cachedIgId;
  const given = env("INSTAGRAM_ACCOUNT_ID");
  if (given) return (cachedIgId = given);
  const page = await graph("GET", pageId(), { params: { fields: "instagram_business_account" } });
  if (!page.instagram_business_account) {
    throw new Error("No Instagram professional account is linked to this Facebook Page. Link one in Page settings, or set INSTAGRAM_ACCOUNT_ID.");
  }
  return (cachedIgId = page.instagram_business_account.id);
}

// ---------- Facebook ----------

const toUnix = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid date "${iso}". Use ISO 8601, e.g. 2026-10-05T09:30:00+05:30.`);
  return Math.floor(t / 1000);
};

async function uploadPhoto(src, extra) {
  if (isUrl(src)) return graph("POST", `${pageId()}/photos`, { params: { url: src, ...extra } });
  const img = await loadImage(src);
  return graph("POST", `${pageId()}/photos`, { params: extra, file: { field: "source", buffer: img.buffer, name: img.name, contentType: img.contentType } });
}

/** Publish (or natively schedule) a Page post. One image becomes a photo post; several become a multi-photo post. */
export async function facebookCreatePost({ text = "", link, images = [], scheduledTime }) {
  const timing = scheduledTime ? { published: false, scheduled_publish_time: toUnix(scheduledTime) } : {};
  const withLink = link && images.length && !text.includes(link) ? `${text}\n\n${link}`.trim() : text;
  let id;
  if (images.length === 1) {
    const r = await uploadPhoto(images[0], { caption: withLink, ...timing });
    id = r.post_id || r.id;
  } else if (images.length > 1) {
    const media = [];
    for (const src of images) media.push({ media_fbid: (await uploadPhoto(src, { published: false, ...(scheduledTime && { temporary: true }) })).id });
    id = (await graph("POST", `${pageId()}/feed`, { params: { message: withLink, attached_media: media, ...timing } })).id;
  } else {
    if (!text && !link) throw new Error("A Facebook post needs text, a link or an image.");
    id = (await graph("POST", `${pageId()}/feed`, { params: { message: text, link, ...timing } })).id;
  }
  if (scheduledTime) return { id, scheduledFor: scheduledTime };
  const info = await graph("GET", id, { params: { fields: "permalink_url" } }).catch(() => ({}));
  return { id, url: info.permalink_url };
}

// ---------- Instagram ----------

async function waitForContainer(id, maxMs) {
  const until = Date.now() + maxMs;
  for (;;) {
    const { status_code, status } = await graph("GET", id, { params: { fields: "status_code,status" } });
    if (status_code === "FINISHED" || status_code === "PUBLISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`Instagram could not process the media (${status_code}): ${status || "no detail given"}`);
    if (Date.now() > until) throw new Error(`Instagram is still processing the media after ${Math.round(maxMs / 1000)}s (container ${id}). Try publishing again later.`);
    await sleep(3000);
  }
}

const isVideo = (url) => /\.(mp4|mov)(\?|$)/i.test(url);

/**
 * Publish to Instagram. Media must be at public https URLs — Instagram fetches them itself.
 * One item is a single post, 2-10 a carousel. type REELS/STORIES applies to a single item.
 */
export async function instagramCreatePost({ caption = "", media = [], type = "FEED", altText, shareToFeed }) {
  if (!media.length) throw new Error("Instagram posts need at least one image or video URL.");
  const local = media.find((m) => !isUrl(m));
  if (local) throw new Error(`Instagram can only publish media from a public https URL, not a local file (${local}). Host the file somewhere public first.`);
  if (media.length > 10) throw new Error("An Instagram carousel holds at most 10 items.");
  const ig = await igId();
  const container = (params) => graph("POST", `${ig}/media`, { params }).then((r) => r.id);
  const mediaParams = (url, carousel) =>
    isVideo(url)
      ? { video_url: url, media_type: carousel ? "VIDEO" : type === "STORIES" ? "STORIES" : "REELS", ...(shareToFeed !== undefined && !carousel && { share_to_feed: shareToFeed }) }
      : { image_url: url, ...(type === "STORIES" && !carousel && { media_type: "STORIES" }), ...(altText && type !== "STORIES" && { alt_text: altText }) };

  let creation;
  if (media.length === 1) {
    creation = await container({ ...mediaParams(media[0], false), ...(type !== "STORIES" && { caption }) });
  } else {
    if (type !== "FEED") throw new Error("Reels and stories take a single media item; carousels are feed posts.");
    const children = [];
    for (const url of media) {
      const id = await container({ ...mediaParams(url, true), is_carousel_item: true });
      await waitForContainer(id, isVideo(url) ? 300_000 : 60_000);
      children.push(id);
    }
    creation = await container({ media_type: "CAROUSEL", children: children.join(","), caption });
  }
  await waitForContainer(creation, media.some(isVideo) ? 300_000 : 60_000);
  const { id } = await graph("POST", `${ig}/media_publish`, { params: { creation_id: creation } });
  const info = await graph("GET", id, { params: { fields: "permalink" } }).catch(() => ({}));
  return { id, url: info.permalink };
}

// ---------- tools ----------

const fbPostId = z.string().regex(/^\d+(_\d+)?$/).describe("Facebook post ID (pageId_postId), from facebook_create_post or facebook_list_posts");
const commentId = z.string().regex(/^\d+(_\d+)?$/).describe("Comment ID");
const igMediaId = z.string().regex(/^\d+$/).describe("Instagram media ID, from instagram_create_post or instagram_list_media");
const limit = z.number().int().min(1).max(100).optional().describe("Default 10");
const after = z.string().optional().describe("Paging cursor from a previous result's `next`");
const page = (r) => ({ items: r.data, next: r.paging?.cursors?.after && r.paging?.next ? r.paging.cursors.after : null });

export function registerFacebook(tool) {
  tool(
    "facebook_get_page",
    "Show the Facebook Page this server manages: name, link, followers, and the linked Instagram account.",
    {},
    READ,
    () => graph("GET", pageId(), { params: { fields: "id,name,username,link,category,fan_count,followers_count,instagram_business_account{id,username}" } })
  );

  tool(
    "facebook_create_post",
    "Publish a post on the Facebook Page now, or schedule it with Facebook's own scheduler. Supports text, a link, and images (local paths or URLs). Public and real — confirm the final text with the user first.",
    {
      text: z.string().optional().describe("Post text"),
      link: z.string().url().optional().describe("URL to share; Facebook builds the preview card"),
      images: z.array(z.string()).max(10).optional().describe("Local file paths or https URLs"),
      scheduledTime: z.string().optional().describe("ISO 8601 time to publish, between 10 minutes and 30 days from now. Facebook holds and publishes it, so this computer need not be on."),
    },
    WRITE,
    (a) => facebookCreatePost(a)
  );

  tool(
    "facebook_list_posts",
    "List the Page's posts, newest first, or its posts waiting in Facebook's scheduler.",
    { scheduled: z.boolean().optional().describe("true lists scheduled, unpublished posts"), limit, after },
    READ,
    async (a) =>
      page(
        await graph("GET", `${pageId()}/${a.scheduled ? "scheduled_posts" : "posts"}`, {
          params: { fields: "id,message,created_time,scheduled_publish_time,permalink_url,status_type,is_published", limit: a.limit || 10, after: a.after },
        })
      )
  );

  tool("facebook_get_post", "Get one Facebook Page post.", { postId: fbPostId }, READ, (a) =>
    graph("GET", a.postId, { params: { fields: "id,message,created_time,permalink_url,status_type,is_published,scheduled_publish_time,attachments{media_type,url,title}" } })
  );

  tool(
    "facebook_update_post",
    "Edit the text of a Facebook Page post. Only posts created through this app can be edited.",
    { postId: fbPostId, text: z.string() },
    WRITE,
    (a) => graph("POST", a.postId, { params: { message: a.text } })
  );

  tool("facebook_delete_post", "Permanently delete a Facebook Page post, or cancel a scheduled one. This cannot be undone.", { postId: fbPostId }, DESTRUCTIVE, (a) =>
    graph("DELETE", a.postId)
  );

  tool(
    "facebook_get_post_stats",
    "Get engagement for a Facebook Page post: reactions, comments and shares, plus any insights metrics asked for.",
    {
      postId: fbPostId,
      metrics: z.array(z.string()).optional().describe("Optional post insights metrics, e.g. post_impressions_unique, post_clicks. Meta retires metrics often; an unknown one returns an error for that part only."),
    },
    READ,
    async (a) => {
      const p = await graph("GET", a.postId, { params: { fields: "id,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" } });
      const out = { id: p.id, url: p.permalink_url, createdAt: p.created_time, reactions: p.reactions?.summary?.total_count ?? 0, comments: p.comments?.summary?.total_count ?? 0, shares: p.shares?.count ?? 0 };
      if (a.metrics?.length) {
        const ins = await graph("GET", `${a.postId}/insights`, { params: { metric: a.metrics.join(",") } }).catch((e) => ({ error: e.message }));
        out.insights = ins.error || Object.fromEntries(ins.data.map((m) => [m.name, m.values?.[0]?.value]));
      }
      return out;
    }
  );

  tool(
    "facebook_get_page_insights",
    "Get Page-level insights for a date range. Metric names change between Graph API versions; see Meta's Page Insights reference for the current list.",
    {
      metrics: z.array(z.string()).min(1).describe("e.g. page_impressions_unique, page_post_engagements, page_follows, page_views_total"),
      period: z.enum(["day", "week", "days_28"]).optional().describe("Default day"),
      since: z.string().optional().describe("ISO date"),
      until: z.string().optional().describe("ISO date"),
    },
    READ,
    async (a) =>
      (await graph("GET", `${pageId()}/insights`, {
        params: { metric: a.metrics.join(","), period: a.period || "day", since: a.since && toUnix(a.since), until: a.until && toUnix(a.until) },
      })).data
  );

  tool(
    "facebook_list_comments",
    "List comments on a Facebook Page post, or replies to a comment (pass the comment ID).",
    { target: z.string().regex(/^\d+(_\d+)?$/).describe("Post ID, or a comment ID to list its replies"), limit, after },
    READ,
    async (a) =>
      page(await graph("GET", `${a.target}/comments`, { params: { fields: "id,message,from,created_time,like_count,comment_count,is_hidden,parent{id}", order: "reverse_chronological", limit: a.limit || 20, after: a.after } }))
  );

  tool(
    "facebook_create_comment",
    "Comment on a Facebook Page post, or reply to a comment, as the Page. Public and real — confirm the text with the user first.",
    { target: z.string().regex(/^\d+(_\d+)?$/).describe("Post ID to comment on, or comment ID to reply to"), text: z.string() },
    WRITE,
    (a) => graph("POST", `${a.target}/comments`, { params: { message: a.text } })
  );

  tool("facebook_hide_comment", "Hide or unhide a comment on the Facebook Page. Hidden comments stay visible to their author and the author's friends.", { commentId, hidden: z.boolean() }, WRITE, (a) =>
    graph("POST", a.commentId, { params: { is_hidden: a.hidden } })
  );

  tool("facebook_delete_comment", "Permanently delete a comment on the Facebook Page.", { commentId }, DESTRUCTIVE, (a) => graph("DELETE", a.commentId));
}

export function registerInstagram(tool) {
  tool("instagram_get_account", "Show the Instagram professional account this server manages: username, followers, post count.", {}, READ, async () =>
    graph("GET", await igId(), { params: { fields: "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website" } })
  );

  tool(
    "instagram_create_post",
    "Publish to Instagram now: a photo, a reel, a story, or a carousel of 2-10 items. Media must be at public https URLs (Instagram downloads them); images must be JPEG. Public and real — confirm caption and media with the user first. Links in captions are not clickable.",
    {
      media: z.array(z.string().url()).min(1).max(10).describe("Public https URLs of JPEG images or MP4/MOV videos"),
      caption: z.string().max(2200).optional().describe("Caption, up to 2200 characters and 30 hashtags. Not used for stories."),
      type: z.enum(["FEED", "REELS", "STORIES"]).optional().describe("Default FEED. A single video is always published as a reel."),
      altText: z.string().optional().describe("Alt text for a single image"),
      shareToFeed: z.boolean().optional().describe("For reels: also show in the main feed"),
    },
    WRITE,
    (a) => instagramCreatePost(a)
  );

  tool("instagram_get_publishing_limit", "Check how many of the 100 API posts allowed per rolling 24 hours have been used.", {}, READ, async () =>
    (await graph("GET", `${await igId()}/content_publishing_limit`, { params: { fields: "quota_usage,config" } })).data
  );

  tool("instagram_list_media", "List the Instagram account's posts, newest first.", { limit, after }, READ, async (a) =>
    page(await graph("GET", `${await igId()}/media`, { params: { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count", limit: a.limit || 10, after: a.after } }))
  );

  tool("instagram_get_media", "Get one Instagram post, including its media URL.", { mediaId: igMediaId }, READ, (a) =>
    graph("GET", a.mediaId, { params: { fields: "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,is_comment_enabled,children{media_type,media_url}" } })
  );

  tool(
    "instagram_get_media_insights",
    "Get insights for one Instagram post. Defaults suit feed posts and reels; available metrics differ by media type.",
    { mediaId: igMediaId, metrics: z.array(z.string()).optional().describe("Default: views, reach, likes, comments, shares, saved, total_interactions") },
    READ,
    async (a) => {
      const metric = (a.metrics || ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"]).join(",");
      const r = await graph("GET", `${a.mediaId}/insights`, { params: { metric } });
      return Object.fromEntries(r.data.map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value]));
    }
  );

  tool(
    "instagram_get_account_insights",
    "Get account-level Instagram insights as totals for a date range of up to 30 days. Not available for accounts under 100 followers.",
    {
      metrics: z.array(z.string()).optional().describe("Default: reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, follows_and_unfollows, profile_links_taps"),
      since: z.string().optional().describe("ISO date; default 7 days ago"),
      until: z.string().optional().describe("ISO date; default now"),
    },
    READ,
    async (a) => {
      const metric = (a.metrics || ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "follows_and_unfollows", "profile_links_taps"]).join(",");
      const until = a.until ? toUnix(a.until) : Math.floor(Date.now() / 1000);
      const since = a.since ? toUnix(a.since) : until - 7 * 86400;
      const r = await graph("GET", `${await igId()}/insights`, { params: { metric, period: "day", metric_type: "total_value", since, until } });
      return Object.fromEntries(r.data.map((m) => [m.name, m.total_value?.value ?? m.total_value]));
    }
  );

  tool(
    "instagram_list_comments",
    "List comments on an Instagram post, or replies to a comment (pass the comment ID with replies=true).",
    { target: z.string().regex(/^\d+$/).describe("Media ID, or a comment ID when replies is true"), replies: z.boolean().optional(), limit, after },
    READ,
    async (a) =>
      page(await graph("GET", `${a.target}/${a.replies ? "replies" : "comments"}`, { params: { fields: "id,text,username,timestamp,like_count,hidden", limit: a.limit || 20, after: a.after } }))
  );

  tool(
    "instagram_create_comment",
    "Comment on your Instagram post, or reply to a comment on it, as the account. Public and real — confirm the text with the user first.",
    { target: z.string().regex(/^\d+$/).describe("Media ID to comment on, or comment ID when replyToComment is true"), text: z.string().max(2200), replyToComment: z.boolean().optional() },
    WRITE,
    (a) => graph("POST", `${a.target}/${a.replyToComment ? "replies" : "comments"}`, { params: { message: a.text } })
  );

  tool("instagram_hide_comment", "Hide or unhide a comment on your Instagram post.", { commentId: z.string().regex(/^\d+$/), hidden: z.boolean() }, WRITE, (a) =>
    graph("POST", a.commentId, { params: { hide: a.hidden } })
  );

  tool("instagram_delete_comment", "Permanently delete a comment on your Instagram post.", { commentId: z.string().regex(/^\d+$/) }, DESTRUCTIVE, (a) => graph("DELETE", a.commentId));

  tool("instagram_set_comments_enabled", "Turn comments on or off for one of your Instagram posts.", { mediaId: igMediaId, enabled: z.boolean() }, WRITE, (a) =>
    graph("POST", a.mediaId, { params: { comment_enabled: a.enabled } })
  );
}
