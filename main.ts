import express from 'express';
// Keep all your existing imports (database, etc.) here
import { saveExhibitionsToDB, getAllEventsFromDB } from './database'; 
import { renderHTML } from './uiux.ts';
import { generateMagicToken } from './auth';
import db from './database'; 

const app = express();
const PORT = Number(process.env.PORT) || 3000;

import session from 'express-session';

// This tells TypeScript that our session has a userId
declare module 'express-session' {
  interface SessionData {
    userId: number;
  }
}

app.use(session({
  secret: 'super-secret-paris-key', // Change this later!
  resave: false,
  saveUninitialized: false,
  rolling: true, // This is the 48-hour reset logic
  cookie: {
    maxAge: 48 * 60 * 60 * 1000, // 48 hours in milliseconds
    httpOnly: true, // Prevents "Cross-site scripting" attacks
    secure: false // Set to true once we move to HTTPS/Cloud
  }
}));


// --- THE NEW "SWITCHBOARD" ---

app.get('/login', (req, res) => {
    const email = req.query.email as string;
    
    if (!email) {
        return res.send('Please provide an email: ?email=test@example.com');
    }

    const token = generateMagicToken(email);
    
    // Since we don't have an email provider set up yet, 
    // we "send" the link by showing it on the screen.
    const magicLink = `http://localhost:3000/verify?token=${token}`;
    
    res.send(`
        <h1>Check your "Email"</h1>
        <p>In a production app, we would email this to you.</p>
        <p>For now, click here: <a href="${magicLink}">${magicLink}</a></p>
    `);
});

app.get('/verify', (req, res) => {
    const token = req.query.token as string;

    const authRecord = db.prepare(`
        SELECT * FROM auth_tokens 
        WHERE token = ? AND used = 0 AND expires_at > DATETIME('now')
    `).get(token) as any;

    if (!authRecord) {
        return res.status(401).send("Invalid or expired magic link.");
    }

    // 1. Burn the token
    db.prepare('UPDATE auth_tokens SET used = 1 WHERE token = ?').run(token);

    // 2. Set the session!
    req.session.userId = authRecord.user_id;

    // 3. Redirect to home
    res.redirect('/');
});

// main.ts
// main.ts

app.get('/', async (req, res) => {
    try {
        // DELETE the syncExhibitionsIfNeeded() line here!
        // Just call the database getter.
        const exhibitions = await getAllEventsFromDB(); 
        
        const html = renderHTML(exhibitions, req.session.userId);
        res.send(html);
    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading page.");
    }
});

app.listen(PORT, () => {
    import { syncExhibitionsIfNeeded } from './fetchExhibitions';

// ... (existing code)

app.listen(PORT, '0.0.0.0', async () => {
    // '0.0.0.0' is CRITICAL for cloud deployments
    console.log(`🚀 Server ready on port ${PORT}`);
    
    try {
        console.log("Checking for data sync...");
        await syncExhibitionsIfNeeded();
        console.log("Sync process finished.");
    } catch (err) {
        console.error("Initial sync failed:", err);
    }
});
