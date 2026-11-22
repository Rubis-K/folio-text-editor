import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('PRAGMA user_version').get().user_version;
    for (const { idx, tag } of journal.entries.slice(current)) {
      db.exec(readFileSync(new URL('../drizzle/' + tag + '.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = ' + (idx + 1));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return {
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql);
      const bound = (params) => ({
        first: async () => statement.get(...params) ?? null,
        all: async () => ({ results: statement.all(...params) }),
        run: async () => ({ meta: statement.run(...params) }),
        execute: () => statement.run(...params),
      });
      return { ...bound([]), bind: (...params) => bound(params) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({ meta: statement.execute() }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
