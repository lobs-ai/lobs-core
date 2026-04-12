import { initDb, getDb } from './dist/db/connection.js';
import { chatSessions, chatMessages } from './dist/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { generateChatTitle } from './dist/services/chat-summarizer.js';

const dbPath = process.env.HOME + '/.lobs/lobs.db';
initDb(dbPath);
const db = getDb();

const session = db.select().from(chatSessions)
  .where(eq(chatSessions.sessionKey, 'chat-41d376ea21194a959177362793911463'))
  .get();
console.log('Session:', session?.label, 'messageCount:', session?.messageCount);

const msgs = db.select().from(chatMessages)
  .where(eq(chatMessages.sessionKey, 'chat-41d376ea21194a959177362793911463'))
  .orderBy(desc(chatMessages.createdAt))
  .limit(3)
  .all();
console.log('Messages:', msgs.length);
msgs.forEach(m => console.log(`  [${m.role}] ${m.content?.substring(0, 80)}`));

console.log('\nCalling generateChatTitle...');
try {
  const title = await generateChatTitle('chat-41d376ea21194a959177362793911463');
  console.log('Title result:', JSON.stringify(title));
} catch (err) {
  console.error('TITLE ERROR:', err.message);
  console.error(err.stack);
}

process.exit(0);
