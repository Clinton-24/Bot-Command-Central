---
name: Telegram 409 polling conflict
description: How to resolve grammy long-polling 409 Conflict errors on bot restart
---

When restarting the bot workflow, Telegram raises 409 Conflict if the previous polling session hasn't expired yet.

**Rule:** After a bot crash or workflow restart, wait ~30–60 seconds before triggering another restart. A rapid re-restart just races the same conflict again.

**Why:** Telegram holds the long-polling connection slot for the lifetime of the previous request (up to 30 seconds). A second getUpdates call during that window is rejected with 409.

**How to apply:** If the bot fails with `409: Conflict: terminated by other getUpdates request`, do NOT restart immediately. Make code edits first (which takes time), then call restart_workflow once. Only restart a second time if the first restart also fails.
