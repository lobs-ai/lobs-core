/**
 * Test setup — initialize an in-memory SQLite DB for all tests.
 */
import { initDb, closeDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { beforeAll, afterAll } from "vitest";

beforeAll(() => {
  const db = initDb(":memory:");
  runMigrations(db);
});

afterAll(() => {
  closeDb();
});
