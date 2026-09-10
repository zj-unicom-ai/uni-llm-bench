import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(__dirname, '../../data/benchmarks.db');

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    dbInstance = new Database(DB_PATH);

    // Enable WAL mode for better concurrent read performance
    dbInstance.pragma('journal_mode = WAL');
    // Set busy timeout to 5 seconds for write contention
    dbInstance.pragma('busy_timeout = 5000');

    console.log('Database initialized (WAL mode, 5s busy timeout)');
  }
  return dbInstance;
}
