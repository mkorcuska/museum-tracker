// 1. ENVIRONMENT & CORE IMPORTS (Must be at the very top)
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import crypto from 'crypto';
import { Resend } from 'resend';

// 2. LOCAL IMPORTS
import db, { saveExhibitionsToDB, getAllEventsFromDB } from './database';
import { getParisExhibitions } from './fetchExhibitions.ts';
import { renderHTML } from './uiux.ts';
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
        dir: '.'
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
    res.locals.userId = req.session.userId || null;

    if (req.session.userId) {
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId) as { email: string } | undefined;
        res.locals.userEmail = user ? user.email : null;
    } else {
        res.locals.userEmail = null;
    }
    next();
});

// ==========================================
// 6. ROUTES
// ==========================================

// --- Home Page ---
app.get('/', async (req, res) => {
    const userId = req.session.userId;
    const exhibitions = await getParisExhibitions();

    if (userId) {
        const savedPrefs = db.prepare('SELECT exhibition_id, priority FROM user_preferences WHERE user_id = ?').all(userId) as { exhibition_id: string, priority: string }[];
        
        const prefMap: Record<string, string> = {};
        savedPrefs.forEach(pref => {
            prefMap[pref.exhibition_id] = pref.priority;
        });

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
        const weightA = priorityWeights[a.priority || 'Recommended'] || 5;
        const weightB = priorityWeights[b.priority || 'Recommended'] || 5;

        if (weightA !== weightB) return weightA - weightB;
        return (a.title || '').localeCompare(b.title || '');
    });

    res.render('index', { exhibitions });
});

// --- Authentication ---
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send("Email is required");

    const token = crypto.randomBytes(32).toString('hex');

    db.prepare(`
        INSERT INTO magic_tokens (email, token, expires)
        VALUES (?, ?, datetime('now', '+15 minutes'))
    `).run(email, token);

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const magicLink = `${baseUrl}/verify?token=${token}`;

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
        SELECT email FROM magic_tokens 
        WHERE token = ? AND expires > datetime('now')
    `).get(cleanToken) as { email: string } | undefined;

    if (!tokenRecord) {
        return res.status(400).send("Link is invalid or expired. Try again.");
    }

    db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').run(tokenRecord.email);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(tokenRecord.email) as { id: number };

    req.session.userId = user.id;
    db.prepare('DELETE FROM magic_tokens WHERE token = ?').run(cleanToken);

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
