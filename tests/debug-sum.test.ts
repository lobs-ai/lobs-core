import { vi, describe, it, expect } from 'vitest';

const mockFetch = vi.fn().mockReturnValue(Promise.resolve({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content: 'Test Title' } }] }),
}));
vi.stubGlobal('fetch', mockFetch);

import { getRawDb } from '../src/db/connection.js';
import { generateChatTitle } from '../src/services/chat-summarizer.js';

// Intercept warn/error to catch the real error
const errors: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.join(' '));
  origError(...args);
};

describe('debug', () => {
  it('simple title gen', async () => {
    const raw = getRawDb();
    raw.exec("DELETE FROM chat_messages; DELETE FROM chat_sessions;");
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO chat_sessions (id, session_key, label, summary, message_count_at_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'dbg1', 'New Chat', null, 0, now);
    raw.prepare(`INSERT INTO chat_messages (id, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'dbg1', 'user', 'Hello', now);
    raw.prepare(`INSERT INTO chat_messages (id, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'dbg1', 'assistant', 'Hi', now);

    const title = await generateChatTitle('dbg1');
    console.log('TITLE RESULT:', title);
    console.log('FETCH CALLS:', mockFetch.mock.calls.length);
    console.log('ERRORS LOGGED:', errors);
    expect(title).toBe('Test Title');
  });
});
