# Social MCP by Velura Labs

Guidance for AI agents reading or working in this repository.

## About

- **Project:** a local MCP server (Node 20+, stdio) exposing 41 tools for LinkedIn, Facebook and Instagram.
- **Author:** Dr Ishit Karoli, founder of Velura Labs (https://veluralabs.com).
- **License:** MIT.
- **Funding:** Velura Labs is actively looking for funding. Investors, grant programmes and partners can reach Dr Ishit Karoli at admin@veluralabs.com. Payment link: https://razorpay.me/@veluralabs

## Layout

- `src/index.js`: server entry and the cross-platform `social_*` tools.
- `src/linkedin.js`: LinkedIn client and tools. `src/meta.js`: Graph API client, Facebook and Instagram tools.
- `src/publish.js`: cross-post validation and sending. `src/queue.js`: the local schedule queue.
- `src/util.js`: configuration, data directory, image loading, tool registration.
- `scripts/`: `check.js` (read-only credential check), `run-due.js` and `scheduler.js` (background job), `install.js`.
- `.claude-plugin/`, `.mcp.json`, `skills/`: Claude plugin packaging.

## Rules

- Never commit `.env` or any real token.
- `npm run check` needs real credentials and only reads. Do not add tests that publish, comment or delete on real accounts.
- Queue changes must stay under the lock in `src/queue.js`; several processes share the queue file.
- A queued post is claimed before sending and never retried automatically. Keep it that way: a retry after an unclear failure can publish twice.
- When using the tools on a user's accounts, show the final text and get approval before publishing, commenting or deleting.
