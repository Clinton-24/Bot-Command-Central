import { Router } from "express";
import { db, externalDbLogsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import nodemailer from "nodemailer";

const router = Router();

async function sendEmail(subject: string, body: string): Promise<void> {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST ?? "smtp.atomicmail.com",
      port: Number(process.env.EMAIL_PORT ?? 587),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: "nullryns@atomicmail.io",
      subject,
      text: body,
    });
  } catch (err) {
    logger.error({ err }, "extdb route email failed");
  }
}

// POST /api/extdb/backup
// Called by your local backup script after a successful backup
// Optional: pass ?secret=YOUR_SECRET or header x-backup-secret for auth
router.post("/extdb/backup", async (req, res) => {
  try {
    const secret = req.query["secret"] || req.headers["x-backup-secret"];
    const expected = process.env.EXTERNAL_BACKUP_SECRET;
    if (expected && String(secret) !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { details, reporter } = req.body || {};
    const date = new Date();
    const formattedDate = `${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getFullYear()}`;
    await db.insert(externalDbLogsTable).values({
      site: "Harmony",
      checkType: "backup",
      status: "success",
      message: `Today, ${formattedDate} backup successful...`,
      details: reporter ? `Reported by: ${reporter}${details ? ` — ${details}` : ""}` : (details ?? null),
    });
    await sendEmail(
      `✅ Harmony DB — Backup Reported`,
      `A backup was reported on ${new Date().toISOString()}.\nDetails: ${details ?? "-"}\nReporter: ${reporter ?? "-"}`
    );
    return res.json({ ok: true, message: "Backup recorded successfully" });
  } catch (err) {
    logger.error({ err }, "extdb backup webhook error");
    return res.status(500).json({ error: "failed" });
  }
});

export default router;
