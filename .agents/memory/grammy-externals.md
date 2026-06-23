---
name: grammy esbuild externals requirement
description: grammy must be kept in build.mjs externals list or the esbuild bundle breaks
---

**Rule:** `grammy` must always remain in the `externals` array of `build.mjs` in the api-server artifact.

**Why:** grammy uses a native Node.js binary (node-fetch / native transport). When bundled by esbuild, the binary resolution fails at runtime.

**How to apply:** Never remove grammy from externals when modifying build.mjs. If adding new packages that use native binaries, add them to externals too.
