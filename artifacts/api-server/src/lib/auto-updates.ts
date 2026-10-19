/**
 * Auto-summarize recent GitHub commits after deploy and notify users.
 * Stores last announced SHA in payment_settings (key: auto_updates_last_sha).
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import type { MyBot } from "../bot/index";

const SETTINGS_KEY = "auto_updates_last_sha";

function repoSlug(): string {
  return (
    process.env.GITHUB_REPO?.trim() ||
    process.env.RENDER_GIT_REPO_SLUG?.trim() ||
    "Clinton-24/Bot-Command-Central"
  );
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT value FROM payment_settings WHERE key = $1 LIMIT 1`, [key]);
    return (r.rows[0]?.value as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO payment_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

type GhCommit = {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } };
  html_url?: string;
};

async function fetchRecentCommits(limit = 20): Promise<GhCommit[]> {
  const repo = repoSlug();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Crescent-Bot-AutoUpdates",
  };
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=${limit}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub commits API ${res.status}`);
  }
  return (await res.json()) as GhCommit[];
}

function cleanMessage(msg: string): string {
  return msg
    .split("\n")[0]!
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function isNoiseCommit(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.startsWith("merge ") ||
    m.includes("placeholder") ||
    m.includes("wip") ||
    m === "update" ||
    m.startsWith("chore: bump")
  );
}

function summarizeCommits(commits: GhCommit[]): { title: string; body: string; headSha: string } {
  const headSha = commits[0]!.sha;
  const lines: string[] = [];
  for (const c of commits) {
    const msg = cleanMessage(c.commit.message);
    if (!msg || isNoiseCommit(msg)) continue;
    const short = c.sha.slice(0, 7);
    lines.push(`• ${msg} (${short})`);
  }
  if (lines.length === 0) {
    lines.push(`• Deploy ${headSha.slice(0, 7)} — maintenance / internal fixes`);
  }

  const n = lines.length;
  const title = n === 1 ? "Bot update shipped" : `${n} updates just shipped`;

  const deployHint = process.env.RENDER_EXTERNAL_URL
    ? `\nService: ${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}`
    : "";

  const body =
    `Here's what changed recently:\n\n` +
    lines.slice(0, 12).join("\n") +
    `\n\nTap /updates anytime for the changelog.` +
    deployHint;

  return { title, body, headSha };
}

async function collectUserIds(): Promise<number[]> {
  const ids = new Set<number>();
  try {
    const u = await pool.query(`SELECT id FROM users`);
    for (const row of u.rows) ids.add(Number(row.id));
  } catch { /* optional */ }
  try {
    const a = await pool.query(
      `SELECT user_id FROM access WHERE tier IS DISTINCT FROM 'blocked'`,
    );
    for (const row of a.rows) ids.add(Number(row.user_id));
  } catch { /* optional */ }
  return [...ids];
}

/**
 * On startup/deploy: if there are new commits since last auto-announce, summarize and notify users.
 */
export async function runAutoUpdateAnnounce(bot: MyBot): Promise<void> {
  if (process.env.AUTO_UPDATES_DISABLED === "1" || process.env.AUTO_UPDATES_DISABLED === "true") {
    logger.info("Auto-updates disabled via AUTO_UPDATES_DISABLED");
    return;
  }

  try {
    const commits = await fetchRecentCommits(25);
    if (!commits.length) {
      logger.info("Auto-updates: no commits returned");
      return;
    }

    const head = commits[0]!.sha;
    const last = await getSetting(SETTINGS_KEY);

    // First run: only seed the tip SHA so we don't spam full history
    if (!last) {
      await setSetting(SETTINGS_KEY, head);
      logger.info({ head: head.slice(0, 7) }, "Auto-updates: seeded last SHA (no broadcast)");
      return;
    }

    if (last === head) {
      logger.info({ head: head.slice(0, 7) }, "Auto-updates: already announced this tip");
      return;
    }

    const fresh: GhCommit[] = [];
    for (const c of commits) {
      if (c.sha === last) break;
      fresh.push(c);
    }
    if (fresh.length === 0) {
      fresh.push(commits[0]!);
    }

    const { title, body, headSha } = summarizeCommits(fresh);

    await pool.query(
      `INSERT INTO bot_announcements (title, body, created_by) VALUES ($1, $2, $3)`,
      [title.slice(0, 120), body.slice(0, 3500), 0],
    );

    const plain =
      `🆕 CRESCENT UPDATE\n━━━━━━━━━━━━━━━━━━\n\n` +
      `${title}\n\n` +
      `${body}`;

    const userIds = await collectUserIds();
    let sent = 0;
    let failed = 0;
    for (const uid of userIds) {
      try {
        await bot.api.sendMessage(uid, plain);
        sent++;
      } catch {
        failed++;
      }
      if ((sent + failed) % 20 === 0) await new Promise((r) => setTimeout(r, 800));
    }

    await setSetting(SETTINGS_KEY, headSha);
    logger.info(
      { head: headSha.slice(0, 7), commits: fresh.length, sent, failed },
      "Auto-updates: announced new commits",
    );
  } catch (err) {
    logger.warn({ err }, "Auto-updates announce skipped");
  }
}
