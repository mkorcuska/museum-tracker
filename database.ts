import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = join(dataDir, 'museums.db');

const db = new Database(dbPath);


// --- 1. INITIALIZATION ---
db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_high_value INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS exhibitions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        venue_id TEXT,
        start_date TEXT,
        end_date TEXT,
        priority TEXT,
        url TEXT,
        cover_url TEXT,
        is_free INTEGER,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    

    CREATE TABLE IF NOT EXISTS user_preferences (
        user_id INTEGER NOT NULL,
        exhibition_id TEXT NOT NULL,
        status TEXT DEFAULT 'Interested',
        priority TEXT DEFAULT 'Nice to See',
        notes TEXT,
        PRIMARY KEY (user_id, exhibition_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (exhibition_id) REFERENCES exhibitions(id)
    );

    CREATE TABLE IF NOT EXISTS user_favorite_venues (
        user_id INTEGER NOT NULL,
        venue_id TEXT NOT NULL,
        is_favorite INTEGER NOT NULL,
        PRIMARY KEY (user_id, venue_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (venue_id) REFERENCES venues(id)
    );
`);


// --- 2. THE GETTER ---
export async function getAllEventsFromDB() {
  // We are commenting out the sync for 5 minutes just to get you running
  // await syncExhibitionsIfNeeded(); 

  return db.prepare(`
        SELECT e.*, v.name as venueName 
        FROM exhibitions e
        JOIN venues v ON e.venue_id = v.id
        ORDER BY 
            CASE WHEN e.priority = 'Must See' THEN 1 ELSE 2 END,
  e.start_date ASC
    `).all();
}

// --- 3. EXPORT DB ---
export default db;
