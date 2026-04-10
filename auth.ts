// auth.ts
import crypto from 'crypto';
import db from './database'; // Adjust based on your export in database.ts

export function generateMagicToken(email: string): string {
    // 1. Create a random 64-character string
    const token = crypto.randomBytes(32).toString('hex');
    
    // 2. Set expiration for 15 minutes from now
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // 3. Ensure the user exists (or create them)
    const user = db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').run(email);
    const userRow = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number };

    // 4. Save the token
    db.prepare(`
        INSERT INTO auth_tokens (token, user_id, expires_at) 
        VALUES (?, ?, ?)
    `).run(token, userRow.id, expiresAt);

    return token;
}