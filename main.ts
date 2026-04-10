import 'dotenv/config';
import express from 'express';
import connectSqlite3 from 'connect-sqlite3';

// Initialize the store adapter
const SQLiteStore = connectSqlite3(session);

import crypto from 'crypto';
import { saveExhibitionsToDB, getAllEventsFromDB } from './database';
import { getParisExhibitions } from './fetchExhibitions.ts';
import { renderHTML } from './uiux.ts';
import { generateMagicToken } from './auth';
import db from './database';
import { Resend } from 'resend';

// Initialize Resend with the API Key (Render will inject this automatically!)
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
// These two lines are the "box cutters" that let Express read incoming data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

import session from 'express-session';

// This tells TypeScript that our session has a userId
declare module 'express-session' {
    interface SessionData {
        userId: number;
    }
}


// The Home Page Route
app.get('/', (req, res) => {
    // This tells Express: "Look in the views folder, find index.ejs, convert it to HTML, and send it"
    res.render('index'); 
});

app.set('trust proxy', 1);

app.use(session({
    // NEW: Tell Express to use SQLite for sessions instead of RAM
    store: new SQLiteStore({
        db: 'sessions.db', // It will auto-create this file
        dir: '.'           // Save it in the root folder next to museums.db
    }),
    secret: process.env.SESSION_SECRET || 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 30 // Keep them logged in for 30 days!
    }
}));

// Make the user data available to ALL EJS templates automatically
app.use((req, res, next) => {
    res.locals.userId = req.session.userId;

    // If they are logged in, fetch their email from the database
    if (req.session.userId) {
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId) as { email: string } | undefined;
        res.locals.userEmail = user ? user.email : null;
    } else {
        res.locals.userEmail = null;
    }

    next();
});

// 1. Show the form
app.get('/login', (req, res) => {
    res.render('login');
});

// 2. Process the form submission
app.post('/login', async (req, res) => { // <--- Add 'async' right here
    const { email } = req.body;
    if (!email) return res.status(400).send("Email is required");

    // Generate a random 32-character string
    const token = crypto.randomBytes(32).toString('hex');

    // Save to database, valid for exactly 15 minutes
    db.prepare(`
        INSERT INTO magic_tokens (email, token, expires)
        VALUES (?, ?, datetime('now', '+15 minutes'))
    `).run(email, token);

    // ==========================================
    // THE REAL EMAIL SENDER
    // ==========================================
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const magicLink = `${baseUrl}/verify?token=${token}`;

    try {
        // We need to 'const data =' here so the console.log can see it!
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: email, 
            subject: '⭐ Your Paris Museum Tracker Login',
            html: `
                <h2>Welcome back!</h2>
                <p>Click the link below to log in:</p>
                <a href="${magicLink}">Log In Now</a>
            `
        });

        if (error) {
            console.error("Resend specific error:", error);
            return res.status(500).send("Resend rejected the email.");
        }

        console.log("Resend Success! ID:", data?.id);

        res.send(`<h2>✨ Magic link sent!</h2><p>Check your inbox.</p>`);
    } catch (error) {
        console.error("System level error:", error);
        return res.status(500).send("The server failed to reach Resend.");
    }
});


app.get('/verify', (req, res) => {
    // 1. Force the token to be a string and scrub any phantom terminal spaces
    const rawToken = req.query.token as string;
    const cleanToken = rawToken ? rawToken.trim() : '';

    // 2. Look it up with the clean token
    const tokenRecord = db.prepare(`
        SELECT email FROM magic_tokens 
        WHERE token = ? AND expires > datetime('now')
    `).get(cleanToken) as { email: string } | undefined;

    if (!tokenRecord) {
        return res.status(400).send("Link is invalid or expired. Try again.");
    }

    // 3. Find or create the user
    db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').run(tokenRecord.email);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(tokenRecord.email) as { id: number };

    // 4. Log them in!
    req.session.userId = user.id;

    // 5. Burn the token (Using cleanToken!)
    db.prepare('DELETE FROM magic_tokens WHERE token = ?').run(cleanToken);

    // 6. Send them home
    res.redirect('/');
});

// 3. Log the user out
app.get('/logout', (req, res) => {
    // Destroy the session in the SQLite database
    req.session.destroy((err) => {
        if (err) {
            console.error("Error destroying session:", err);
            return res.status(500).send("Could not log out.");
        }

        // Clear the session cookie from the user's browser
        res.clearCookie('connect.sid');

        // Send them back to the homepage as an anonymous visitor
        res.redirect('/');
    });
});

app.post('/update-priority', (req, res) => {
    // 1. Grab the data from the button and the active user session
    const { exhibitionId, priority } = req.body;
    const userId = req.session.userId;

    // 2. Security Check: Block anonymous clicks
    if (!userId) {
        return res.status(401).send("You must be logged in to save tags.");
    }

    // 3. The "Upsert" (Update or Insert)
    try {
        db.prepare(`
            INSERT INTO user_preferences (user_id, exhibition_id, priority)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, exhibition_id) DO UPDATE SET priority = excluded.priority
        `).run(userId, exhibitionId, priority);

        console.log(`✅ User ${userId} marked exhibition ${exhibitionId} as ${priority}`);
        res.status(200).send({ success: true });
    } catch (err) {
        console.error("Database error saving preference:", err);
        res.status(500).send({ success: false });
    }
});

app.get('/', async (req, res) => {
    const userId = req.session.userId;

    // 1. Fetch your raw list of exhibitions from your API/JSON
    const exhibitions = await getParisExhibitions();

    // 2. If the user is logged in, overwrite the default tags with their saved tags
    if (userId) {
        // Fetch all their personal saved tags
        const savedPrefs = db.prepare('SELECT exhibition_id, priority FROM user_preferences WHERE user_id = ?').all(userId) as { exhibition_id: string, priority: string }[];

        // Convert to a quick lookup dictionary (e.g., { "exhibit-123": "Must See" })
        const prefMap: Record<string, string> = {};
        savedPrefs.forEach(pref => {
            prefMap[pref.exhibition_id] = pref.priority;
        });

        // Loop through the exhibitions and apply the user's tags
        exhibitions.forEach(ex => {
            if (prefMap[ex.id]) {
                ex.priority = prefMap[ex.id];
            }
        });
    }

    const priorityWeights: Record<string, number> = {
        'Must See': 1,
        'Recommended': 2,
        'Nice to See': 3,
        'Ignore': 4
    };

    exhibitions.sort((a, b) => {
        // Get the weight of each card (default to 'Recommended' if undefined)
        const weightA = priorityWeights[a.priority || 'Recommended'] || 5;
        const weightB = priorityWeights[b.priority || 'Recommended'] || 5;

        // Primary Sort: By Priority Weight
        if (weightA !== weightB) {
            return weightA - weightB;
        }

        // Secondary Sort: Alphabetical by Title (if they have the same priority)
        return (a.title || '').localeCompare(b.title || '');
    });

    // 3. Send the customized list to the EJS template
    res.render('index', { exhibitions });
});


const PORT = Number(process.env.PORT) || 3000;

// 1. Start the server IMMEDIATELY so Render sees an open port
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ready on port ${PORT}`);

    // 2. Trigger the sync in the background AFTER the port is open
    // We don't 'await' it here so the server stays responsive
    console.log("Checking for initial data sync in background...");
    getParisExhibitions()
        .then(data => console.log(`Initial sync complete. Found ${data.length} exhibitions.`))
        .catch(err => console.error("Initial sync failed:", err));
});

