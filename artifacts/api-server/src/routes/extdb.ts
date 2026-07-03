import { Router } from "express";
import { markExternalBackup, notifyByEmail } from "../bot/handlers/extdblogs";
import { logger } from "../lib/logger";

const router = Router();

// POST /api/extdb/backup
// Body: { site?: string, details?: string, reporter?: string }
// Optional header/query: ?secret= or x-backup-secret
router.post("/extdb/backup", async (req, res) => {
  try {
    const secret = req.query.secret || req.headers["x-backup-secret"];
    const expected = process.env.EXTERNAL_BACKUP_SECRET;
    if (expected && String(secret) !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { site, details, reporter } = req.body || {};
    await markExternalBackup(site, details, reporter);
    // send email notification
    await notifyByEmail(`Backup reported — ${site ?? "external"}`, `Backup reported for ${site ?? "external"} on ${new Date().toISOString()}\nDetails: ${details ?? "-"}\nReporter: ${reporter ?? "-"}`);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "extdb backup webhook error");
    return res.status(500).json({ error: "failed" });
  }
});

export default router;
