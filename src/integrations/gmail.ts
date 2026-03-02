/**
 * Gmail Integration
 * Port of lobs-server/app/services/email_service.py
 * Checks unread emails and creates inbox items for important ones.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import { log } from "../util/logger.js";

const LOBS_SERVER_DIR = process.env.LOBS_SERVER_DIR ?? `${process.env.HOME}/lobs-server`;
const GMAIL_TOKEN_FILE = process.env.GMAIL_TOKEN_FILE ?? join(LOBS_SERVER_DIR, "credentials/gmail_token.json");
const GMAIL_CREDENTIALS_FILE = process.env.GMAIL_CREDENTIALS_FILE ?? join(LOBS_SERVER_DIR, "credentials/gmail.json");

export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  labels: string[];
}

// Keywords that indicate an email is important
const IMPORTANT_KEYWORDS = ["urgent", "action required", "invoice", "payment", "deadline", "critical", "alert", "security"];

export class GmailService {
  isConfigured(): boolean {
    return existsSync(GMAIL_TOKEN_FILE);
  }

  /**
   * Fetch unread emails via Python bridge.
   */
  fetchUnread(maxResults = 20): EmailMessage[] {
    if (!this.isConfigured()) {
      log().info("[GMAIL] Not configured — missing token file");
      return [];
    }

    try {
      const pyScript = join(LOBS_SERVER_DIR, "bin/fetch_gmail.py");
      if (existsSync(pyScript)) {
        const result = spawnSync("python3", [pyScript, "--max", String(maxResults), "--json"], {
          encoding: "utf8", timeout: 30_000,
        });
        if (result.status === 0 && result.stdout) {
          return JSON.parse(result.stdout) as EmailMessage[];
        }
        log().warn(`[GMAIL] Python bridge failed: ${result.stderr?.slice(0, 200)}`);
      }
    } catch (e) {
      log().warn(`[GMAIL] fetchUnread failed: ${String(e)}`);
    }
    return [];
  }

  /**
   * Process inbox: fetch unread, filter important, create inbox items.
   */
  processInbox(): { processed: number; created: number } {
    const emails = this.fetchUnread();
    const db = getDb();
    let created = 0;

    for (const email of emails) {
      if (!this._isImportant(email)) continue;

      const now = new Date().toISOString();
      const itemId = `email_${email.id}`;
      try {
        const existing = db.select().from(inboxItems)
          .where(require("drizzle-orm").eq(inboxItems.id, itemId))
          .get();
        if (existing) continue;

        db.insert(inboxItems).values({
          id: itemId,
          title: `📧 ${email.subject}`,
          content: `**From:** ${email.from}\n**Received:** ${email.receivedAt}\n\n${email.snippet}`,
          summary: email.snippet.slice(0, 150),
          isRead: false,
          modifiedAt: email.receivedAt,
        }).run();
        created++;
      } catch (e) {
        log().warn(`[GMAIL] Failed to create inbox item for ${email.id}: ${String(e)}`);
      }
    }

    log().info(`[GMAIL] Processed ${emails.length} emails, created ${created} inbox items`);
    return { processed: emails.length, created };
  }

  private _isImportant(email: EmailMessage): boolean {
    const text = `${email.subject} ${email.snippet}`.toLowerCase();
    return IMPORTANT_KEYWORDS.some(kw => text.includes(kw));
  }
}
