// 1. ENVIRONMENT & CORE IMPORTS (Must be at the very top)
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import crypto from 'crypto';
import { Resend } from 'resend';
import * as fs from 'fs';
import { join } from 'path';

// 2. LOCAL IMPORTS
import db from './database';
import { getParisExhibitions, VALID_KEYWORDS } from './fetchExhibitions.ts';
import { generateMagicToken } from './auth';
import { translations } from './translations.ts';

// 3. TYPESCRIPT DECLARATIONS
declare module 'express-session' {
    interface SessionData {
        userId: number;
        userEmail: string;
        lang: 'en' | 'fr';
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
app.use(express.static('public')); // Serve static assets like CSS and JS

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
    if (!req.session.lang) {
        // Detect the best match from the browser, default to 'en' if no match
        const detected = req.acceptsLanguages('en', 'fr');
        req.session.lang = (detected === 'fr') ? 'fr' : 'en';
    }
    const lang = req.session.lang;
    res.locals.lang = lang;
    res.locals.t = (key: string) => translations[lang][key] || key;

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

// --- Admin Page ---
app.get('/admin', (req, res) => {
    // In a production app, you would add: if (!req.session.userId) return res.redirect('/login');
    // For now, we leave it open so you can test it easily.
    
    const tagsPath = join(dataDir, 'all_api_tags.json');
    const rejectedPath = join(dataDir, 'rejected_cache.json');
    
    const tags = fs.existsSync(tagsPath) ? JSON.parse(fs.readFileSync(tagsPath, 'utf-8')) : [];
    const rejected = fs.existsSync(rejectedPath) ? JSON.parse(fs.readFileSync(rejectedPath, 'utf-8')) : [];
    
    res.render('admin', { tags, rejected, validKeywords: VALID_KEYWORDS });
});

app.post('/admin/refresh', async (req, res) => {
    const cachePath = join(dataDir, 'exhibitions_cache.json');
    if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath); // Delete the cache file
    }
    await getParisExhibitions();  // Force a fresh fetch
    res.redirect('/admin');       // Reload the page
});

// --- Authentication ---
app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/set-lang/:lang', (req, res) => {
    const lang = req.params.lang;
    if (lang === 'en' || lang === 'fr') {
        req.session.lang = lang;
    }
    res.redirect(req.get('Referrer') || '/');
});

app.post('/login', async (req, res) => {
    const lang = req.session.lang || 'en';
    const t = (key: string) => translations[lang][key] || key;

    const { email } = req.body;
    if (!email) return res.status(400).send(t('email_required'));

    const token = generateMagicToken(email);

    const protocol = req.protocol;
    const magicLink = `${protocol}://${req.get('host')}/verify?token=${token}`;

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
            to: email,
            subject: t('email_subject'),
            html: `
                <h2>${t('email_welcome')}</h2>
                <p>${t('email_click_link')}</p>
                <a href="${magicLink}">${t('email_log_in_now')}</a>
            `
        });

        if (error) {
            console.error("Resend specific error:", error);
            return res.status(500).send("Resend rejected the email.");
        }

        console.log("Resend Success! ID:", data?.id);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2>${t('magic_link_sent')}</h2>
                <p>${t('check_inbox')}</p>
                <p style="color: #6a737d; font-size: 14px;">${t('redirect_msg')}</p>
            </div>
            <script>
                // Listen for the login success signal from the new tab
                window.addEventListener('storage', (e) => {
                    if (e.key === 'museum_login_sync') window.location.href = '/';
                });
            </script>
        `);
    } catch (error) {
        console.error("System level error:", error);
        return res.status(500).send("The server failed to reach Resend.");
    }
});

app.get('/verify', (req, res) => {
    const lang = req.session.lang || 'en';
    const t = (key: string) => translations[lang][key] || key;

    const rawToken = req.query.token as string;
    const cleanToken = rawToken ? rawToken.trim() : '';

    const tokenRecord = db.prepare(`
        SELECT a.user_id, u.email 
        FROM auth_tokens a
        JOIN users u ON a.user_id = u.id
        WHERE a.token = ? AND a.expires_at > datetime('now') AND a.used = 0
    `).get(cleanToken) as { user_id: number, email: string } | undefined;

    if (!tokenRecord) {
        return res.status(400).send(t('invalid_link'));
    }

    req.session.userId = tokenRecord.user_id;
    req.session.userEmail = tokenRecord.email;
    db.prepare('UPDATE auth_tokens SET used = 1 WHERE token = ?').run(cleanToken);

    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
            <h2>${t('login_success')}</h2>
            <p>${t('close_window')}</p>
            <p><a href="/" style="color: #0366d6;">${t('continue_in_tab')}</a></p>
        </div>
        <script>
            // Send the signal to the original tab
            localStorage.setItem('museum_login_sync', Date.now().toString());
            // Attempt to automatically close this new tab (works in most browsers when opened via email link)
            setTimeout(() => { window.close(); }, 2000);
        </script>
    `);
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
    // Delay the initial sync slightly so Render's port scanner can connect first
    setTimeout(() => {
        getParisExhibitions()
            .then(data => console.log(`Initial sync complete. Found ${data.length} exhibitions.`))
            .catch(err => console.error("Initial sync failed:", err));
    }, 1000);
});
