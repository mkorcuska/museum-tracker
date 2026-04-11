// 1. ENVIRONMENT & CORE IMPORTS (Must be at the very top)
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import crypto from 'crypto';
import { Resend } from 'resend';

// 2. LOCAL IMPORTS
import db from './database';
import { getParisExhibitions } from './fetchExhibitions.ts';
import { generateMagicToken } from './auth';

// 3. TYPESCRIPT DECLARATIONS
declare module 'express-session' {
    interface SessionData {
        userId: number;
        userEmail: string;
    }
}

// 4. INITIALIZATION
const app = express();
const SQLiteStore = connectSqlite3(session);
const resend = new Resend(process.env.RESEND_API_KEY);
const dataDir = process.env.DATA_DIR || '.';

// 5. APP CONFIGURATION & MIDDLEWARE
app.set('trust proxy', 1);
app.set('view engine', 'ejs');

// Body parsers (The "box cutters")
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session management
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: dataDir
    }),
    secret: process.env.SESSION_SECRET || 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
    }
}));

// Global template variables (Available to all EJS files)
app.use((req, res, next) => {
    if (req.session.userId) {
        // Verify user still exists (prevents ghost sessions if DB is reset)
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId) as { email: string } | undefined;
        if (user) {
            res.locals.userId = req.session.userId;
            res.locals.userEmail = req.session.userEmail || user.email;
            next();
        } else {
            req.session.destroy(() => {
                res.clearCookie('connect.sid');
                res.redirect('/');
            });
            return; // Stop the request chain so the route handler doesn't run with an undefined session
        }
    } else {
        res.locals.userId = null;
        res.locals.userEmail = null;
        next();
    }
});

// ==========================================
// 6. ROUTES
// ==========================================

// --- Home Page ---
app.get('/', async (req, res) => {
    const userId = req.session.userId;
    const exhibitions = await getParisExhibitions(userId);

    res.render('index', { exhibitions });
});

// --- Authentication ---
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send("Email is required");

    const token = generateMagicToken(email);

    const protocol = req.protocol;
    const magicLink = `${protocol}://${req.get('host')}/verify?token=${token}`;

    try {
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
    const rawToken = req.query.token as string;
    const cleanToken = rawToken ? rawToken.trim() : '';

    const tokenRecord = db.prepare(`
        SELECT a.user_id, u.email 
        FROM auth_tokens a
        JOIN users u ON a.user_id = u.id
        WHERE a.token = ? AND a.expires_at > datetime('now') AND a.used = 0
    `).get(cleanToken) as { user_id: number, email: string } | undefined;

    if (!tokenRecord) {
        return res.status(400).send("Link is invalid or expired. Try again.");
    }

    req.session.userId = tokenRecord.user_id;
    req.session.userEmail = tokenRecord.email;
    db.prepare('UPDATE auth_tokens SET used = 1 WHERE token = ?').run(cleanToken);

    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Error destroying session:", err);
            return res.status(500).send("Could not log out.");
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// --- API Endpoints ---
app.post('/update-priority', (req, res) => {
    const { exhibitionId, priority } = req.body;
    const userId = req.session.userId;

    if (!userId) return res.status(401).send("You must be logged in to save tags.");

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

app.post('/toggle-favorite-venue', (req, res) => {
    const { venueId, isFavorite } = req.body;
    const userId = req.session.userId;

    if (!userId) return res.status(401).send("You must be logged in to favorite venues.");

    try {
        db.prepare(`
            INSERT INTO user_favorite_venues (user_id, venue_id, is_favorite)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, venue_id) DO UPDATE SET is_favorite = excluded.is_favorite
        `).run(userId, venueId, isFavorite ? 1 : 0);

        console.log(`✅ User ${userId} marked venue ${venueId} favorite status: ${isFavorite}`);
        res.status(200).send({ success: true });
    } catch (err) {
        console.error("Database error saving venue preference:", err);
        res.status(500).send({ success: false });
    }
});

// ==========================================
// 7. SERVER STARTUP
// ==========================================
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ready on port ${PORT}`);

    console.log("Checking for initial data sync in background...");
    getParisExhibitions()
        .then(data => console.log(`Initial sync complete. Found ${data.length} exhibitions.`))
        .catch(err => console.error("Initial sync failed:", err));
});
