---
name: social-media
description: How to post to and manage LinkedIn, Facebook and Instagram through the velura-social tools. Use when the user asks to write, publish, schedule, cross-post, edit or delete social media posts, reply to comments, or check post and page statistics.
---

# Managing social media

The `linkedin_*`, `facebook_*`, `instagram_*` and `social_*` tools act on the user's real accounts.

## Before anything public

Publishing, commenting and replying are public and immediate. Before calling a tool that does any of them:

1. Show the user the exact final text for each platform, the images, and which account posts it (profile or company page).
2. Wait for a clear yes. A request such as "draft a post" is not approval to publish.

Deleting a post or comment is permanent. Name what will be deleted and confirm first.

If a tool fails with a credentials or permission error, run `social_status` and report what it says. Do not retry a publish call after an unclear failure without first checking whether the post went out (`linkedin_list_posts`, `facebook_list_posts`, `instagram_list_media`); a blind retry can publish twice.

## Writing for each platform

| | LinkedIn | Facebook | Instagram |
|---|---|---|---|
| Text limit | 3000 characters | long | 2200 characters, 30 hashtags |
| Text-only post | yes | yes | no, needs an image or video |
| Images | local paths or URLs | local paths or URLs | public https URLs only, JPEG |
| Links | preview card | preview card | not clickable in captions |

Use `social_cross_post` to send one post to several platforms, with `linkedinText`, `facebookText` and `instagramCaption` when the wording should differ. It checks for known problems before sending anything. If one platform still fails, the others are already posted: report exactly which succeeded and which failed.

On LinkedIn, hashtags are plain `#tag`. Mention a company with `@[Exact Page Name](urn:li:organization:ID)`; the name must match exactly.

## Scheduling

- Facebook only: `facebook_create_post` with `scheduledTime`. Facebook holds the post, so nothing needs to be running. 10 minutes to 30 days ahead.
- Anything involving LinkedIn or Instagram: `social_schedule_post`. The queue is on the user's computer and posts go out only while this server or the background job is running. Tell the user this when scheduling. A post more than 12 hours late is marked `missed` instead of sent.

Give `sendAt` with an explicit time zone offset, and state the time back to the user in their zone.

Check the queue with `social_list_scheduled`. A `failed` or `partial` item is never retried automatically.

## Comments and statistics

Find posts with the `*_list_posts` / `instagram_list_media` tools, then use the `*_list_comments` tools. Reply in the user's voice only with their approval of the wording.

Statistics differ by platform. LinkedIn impressions and clicks exist only for company page posts. Instagram account insights need at least 100 followers. Report numbers as returned and say when a metric is unavailable rather than estimating.

## Limits

- LinkedIn access tokens expire after 60 days.
- Instagram allows 100 API posts per 24 hours (`instagram_get_publishing_limit`) and cannot delete or edit posts through the API.
- LinkedIn and Facebook posts can have their text edited, not their media.
