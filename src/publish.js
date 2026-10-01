import * as linkedin from "./linkedin.js";
import * as meta from "./meta.js";
import { isUrl } from "./util.js";

export const PLATFORMS = ["linkedin", "facebook", "instagram"];

export const configuredPlatforms = () =>
  PLATFORMS.filter((p) => (p === "linkedin" ? linkedin.configured() : p === "facebook" ? meta.facebookConfigured() : meta.instagramConfigured()));

const SENDERS = {
  linkedin: (p) =>
    linkedin.createPost({ text: p.linkedinText ?? p.text, link: p.link, images: p.images, altTexts: p.altText ? [p.altText] : [], author: p.linkedinAuthor }),
  facebook: (p) => meta.facebookCreatePost({ text: p.facebookText ?? p.text, link: p.link, images: p.images }),
  instagram: (p) => meta.instagramCreatePost({ caption: p.instagramCaption ?? p.text, media: p.images || [], altText: p.altText }),
};

/** Problems that can be known before anything is sent, so a cross-post does not go out half-done. */
export function validate(p) {
  const problems = [];
  const ready = configuredPlatforms();
  for (const platform of p.platforms) {
    if (!ready.includes(platform)) problems.push(`${platform}: not configured (credentials missing).`);
  }
  if (p.platforms.includes("instagram")) {
    if (!p.images?.length) problems.push("instagram: needs at least one image; text-only posts are not possible.");
    else if (p.images.some((i) => !isUrl(i))) problems.push("instagram: images must be public https URLs, not local files.");
  }
  if (!p.text && !p.images?.length && !p.link) problems.push("Nothing to post: give text, a link or images.");
  return problems;
}

/** Post to each platform in turn. One platform failing does not stop the others. */
export async function publish(p) {
  const results = [];
  for (const platform of p.platforms) {
    try {
      results.push({ platform, ok: true, ...(await SENDERS[platform](p)) });
    } catch (e) {
      results.push({ platform, ok: false, error: e.message });
    }
  }
  return results;
}
