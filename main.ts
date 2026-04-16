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
import { generateMagicToken, Venue } from './types.ts';
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
    res.locals.isAdmin = false; // Default to false
    res.locals.t = (key: string) => translations[lang][key] || key;

    if (req.session.userId) {
        // Verify user still exists (prevents ghost sessions if DB is reset)
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId) as { email: string } | undefined;
        if (user) {
            if ((req.session.userEmail || user.email) === 'mkorcuska@gmail.com') {
                res.locals.isAdmin = true;
            }
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
    let exhibitions = await getParisExhibitions(userId);
    const { filter } = req.query;

    res.render('index', { exhibitions });
    if (filter === 'new') {
        exhibitions = exhibitions.filter(e => e.isNew);
    }

    res.render('index', { exhibitions, filter });
});

app.get('/help', (req, res) => {
    res.render('help');
});

// --- Admin Routes (Protected) ---
const adminRouter = express.Router();

// Middleware to protect all admin routes
adminRouter.use((req, res, next) => {
    if (res.locals.isAdmin) {
        return next();
    }
    // If not admin, send a forbidden error or redirect.
    res.status(403).send('Access Denied. You do not have permission to view this page.');
});

adminRouter.get('/', (req, res) => {
    const tagsPath = join(dataDir, 'all_api_tags.json');
    const rejectedPath = join(dataDir, 'rejected_cache.json');
    const cachePath = join(dataDir, 'exhibitions_cache.json');
    
    const tags = fs.existsSync(tagsPath) ? JSON.parse(fs.readFileSync(tagsPath, 'utf-8')) : [];
    const rejected = fs.existsSync(rejectedPath) ? JSON.parse(fs.readFileSync(rejectedPath, 'utf-8')) : [];
    
    let lastRefresh = 'Never';
    if (fs.existsSync(cachePath)) {
        const stats = fs.statSync(cachePath);
        lastRefresh = stats.mtime.toLocaleString();
    }
    
    res.render('admin', { tags, rejected, validKeywords: VALID_KEYWORDS, lastRefresh });
});

adminRouter.get('/raw-data', (req, res) => {
    const cachePath = join(dataDir, 'exhibitions_cache.json');
    if (fs.existsSync(cachePath)) {
        res.header("Content-Type", "application/json");
        res.send(fs.readFileSync(cachePath, 'utf-8'));
    } else {
        res.status(404).send('Cache file not found. Please force a refresh.');
    }
});

adminRouter.get('/add', (req, res) => {
    res.render('add-exhibition', { error: null });
});

adminRouter.post('/add', (req, res) => {
    const { title, venueName, startDate, endDate, url, coverUrl, isFree } = req.body;

    if (!title || !venueName || !startDate || !endDate) {
        return res.status(400).render('add-exhibition', { error: 'Title, Venue, Start Date, and End Date are required.' });
    }

    try {
        // 1. Handle Venue - this will create it if it doesn't exist.
        // We pass an empty array for highValueVenues as it's not available here.
        // The user can favorite the venue in the UI later.
        const venue = new Venue(venueName, []);
        venue.save();

        // 2. Create Exhibition
        const exhibitionId = `manual-${crypto.randomUUID()}`;
        const isFreeInt = isFree === 'on' ? 1 : 0;

        db.prepare(`
            INSERT INTO exhibitions (id, title, venue_id, start_date, end_date, url, cover_url, is_free)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(exhibitionId, title, venue.id, startDate, endDate, url || null, coverUrl || null, isFreeInt);

        console.log(`Manually added exhibition: ${title} (ID: ${exhibitionId})`);

        // 3. Invalidate the cache so the new entry appears on next load
        const cachePath = join(dataDir, 'exhibitions_cache.json');
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
        }

        res.redirect('/');
    } catch (err) {
        console.error("Error adding manual exhibition:", err);
        res.status(500).render('add-exhibition', { error: 'An error occurred while saving the exhibition.' });
    }
});

adminRouter.get('/edit/:id', (req, res) => {
    const exhibitionId = req.params.id;

    // Security check: only allow editing of manual entries
    if (!exhibitionId.startsWith('manual-')) {
        return res.status(403).send('Editing is only allowed for manually added exhibitions.');
    }

    const exhibitionData = db.prepare(`
        SELECT 
            e.id, e.title, e.start_date, e.end_date, e.url, e.cover_url, e.is_free,
            v.name as venueName
        FROM exhibitions e
        JOIN venues v ON e.venue_id = v.id
        WHERE e.id = ?
    `).get(exhibitionId) as any;

    if (!exhibitionData) {
        return res.status(404).send('Exhibition not found.');
    }

    // The EJS template expects Date objects, so we convert the strings
    const exhibition = {
        ...exhibitionData,
        startDate: new Date(exhibitionData.start_date),
        endDate: new Date(exhibitionData.end_date),
    };

    res.render('edit-exhibition', { exhibition, error: null });
});

adminRouter.post('/edit/:id', (req, res) => {
    const exhibitionId = req.params.id;
    const { title, venueName, startDate, endDate, url, coverUrl, isFree } = req.body;

    if (!exhibitionId.startsWith('manual-')) {
        return res.status(403).send('Editing is only allowed for manually added exhibitions.');
    }

    if (!title || !venueName || !startDate || !endDate) {
        // This is a simplified error handling. A more advanced version would re-render the form with user's entered values.
        return res.status(400).redirect(`/admin/edit/${exhibitionId}?error=true`);
    }

    try {
        const venue = new Venue(venueName, []);
        venue.save();
        const isFreeInt = isFree === 'on' ? 1 : 0;

        db.prepare(`
            UPDATE exhibitions
            SET title = ?, venue_id = ?, start_date = ?, end_date = ?, url = ?, cover_url = ?, is_free = ?
            WHERE id = ?
        `).run(title, venue.id, startDate, endDate, url || null, coverUrl || null, isFreeInt, exhibitionId);

        res.redirect('/');
    } catch (err) {
        console.error("Error updating manual exhibition:", err);
        res.status(500).send('An error occurred while updating the exhibition.');
    }
});

adminRouter.post('/refresh', async (req, res) => {
    const cachePath = join(dataDir, 'exhibitions_cache.json');
    if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath); // Delete the cache file
    }
    await getParisExhibitions();  // Force a fresh fetch
    res.redirect('/admin');
});

adminRouter.get('/test-digest', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).send("Not logged in");

    const user = db.prepare('SELECT lang, wants_digest FROM users WHERE id = ?').get(userId) as { lang: 'en' | 'fr', wants_digest: 0 | 1 };
    if (!user) return res.status(404).send("User not found.");

    if (user.wants_digest === 0) {
        return res.send("<h3>This user has opted out of digests. No email would be sent.</h3><p><a href='/profile/edit'>Change preference</a></p>");
    }

    const t = (key: string) => translations[user.lang][key] || key;

    // Grab all exhibitions customized for this specific user
    const exhibitions = await getParisExhibitions(userId);
    
    // 1. New this week from favorite venues
    const newFavorites = exhibitions.filter(e => 
        e.isNew && e.venue.isHighValue && e.priority !== 'Ignore' && e.priority !== 'Attended'
    );

    // 2. Closing soon (Favorite OR Must See)
    const closingSoon = exhibitions.filter(e => 
        e.isClosingSoon && (e.venue.isHighValue || e.priority === 'Must See') && 
        e.priority !== 'Ignore' && e.priority !== 'Attended' &&
        !newFavorites.includes(e) // Prevent duplicates if it's both new AND closing soon
        !newFavorites.some(nf => nf.id === e.id)
    );

    const seenIds = new Set([...newFavorites, ...closingSoon].map(e => e.id));

    // 3. Must see (not already listed above)
    const mustSee = exhibitions.filter(e => 
        e.priority === 'Must See' && 
        !seenIds.has(e.id) && 
        e.priority !== 'Ignore' && e.priority !== 'Attended'
        e.priority === 'Must See' && !seenIds.has(e.id) && e.priority !== 'Ignore' && e.priority !== 'Attended'
    );

    // Bail out if there is absolutely nothing to show
    if (newFavorites.length === 0 && closingSoon.length === 0 && mustSee.length === 0) {
        return res.send("<h3>Digest would be empty. No email would be sent to this user.</h3>");
    }

    // Very basic HTML template for testing the structure
    let html = `<div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">`;
    html += `<h2 style="text-align: center;">🎨 Your Weekly Art Digest</h2><hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 20px;" />`;
    html += `<h2 style="text-align: center;">🎨 ${t('digest_title')}</h2><hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 20px;" />`;
    
    html += `<h3 style="color: #d73a49;">✨ New This Week (Favorite Venues)</h3>`;
    html += `<h3 style="color: #d73a49;">✨ ${t('digest_new_favorites')}</h3>`;
    if (newFavorites.length > 0) {
        newFavorites.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name}</p>`);
    } else {
        html += `<p style="color: #666;">No new exhibitions from your favorite venues this week. <a href="/" style="color: #0366d6;">Click here to see all new exhibitions.</a></p>`;
        html += `<p style="color: #666;">${t('digest_no_new_favorites')} <a href="/?filter=new" style="color: #0366d6;">${t('digest_see_all_new')}</a></p>`;
    }

    html += `<h3 style="color: #d73a49; margin-top: 30px;">⏳ Closing Soon</h3>`;
    html += `<h3 style="color: #d73a49; margin-top: 30px;">⏳ ${t('digest_closing_soon')}</h3>`;
    if (closingSoon.length > 0) {
        closingSoon.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name} <span style="color: #d73a49; font-size: 0.9em;">(Closes ${e.endDate.toLocaleDateString()})</span></p>`);
        closingSoon.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name} <span style="color: #d73a49; font-size: 0.9em;">(Closes ${e.endDate.toLocaleDateString(user.lang)})</span></p>`);
    } else {
        html += `<p style="color: #666;">Nothing on your radar is closing immediately.</p>`;
        html += `<p style="color: #666;">${t('digest_nothing_closing')}</p>`;
    }

    html += `<h3 style="color: #d73a49; margin-top: 30px;">🔥 Your Must See List</h3>`;
    html += `<h3 style="color: #d73a49; margin-top: 30px;">🔥 ${t('digest_must_see')}</h3>`;
    if (mustSee.length > 0) {
        mustSee.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name}</p>`);
        html += `<p style="font-size: 0.9em; font-style: italic; color: #555;">Don't forget to schedule your visit to your Must See exhibitions!</p>`;
        html += `<p style="font-size: 0.9em; font-style: italic; color: #555;">${t('digest_must_see_reminder')}</p>`;
    } else {
        html += `<p style="color: #666;">You're all caught up on your Must See list!</p>`;
        html += `<p style="color: #666;">${t('digest_all_caught_up')}</p>`;
    }

    html += `<div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center;">You are receiving this because you opted in to weekly digests. <a href="#" style="color: #999; text-decoration: underline;">Unsubscribe</a></div></div>`;
    const unsubscribeLink = `${req.protocol}://${req.get('host')}/profile/edit`;
    html += `<div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center;">${t('digest_receiving_because')} <a href="${unsubscribeLink}" style="color: #999; text-decoration: underline;">${t('digest_unsubscribe')}</a></div></div>`;
    
    res.send(html);
});

app.use('/admin', adminRouter);
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
                <div style="font-family: Helvetica, Arial, sans-serif; max-width: 500px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px; text-align: center; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
                    <h2 style="color: #24292e; margin-top: 0;">${t('email_welcome')}</h2>
                    <p style="color: #586069; font-size: 16px; line-height: 1.5;">${t('email_click_link')}</p>
                    <div style="margin: 30px 0;">
                        <a href="${magicLink}" style="background-color: #0366d6; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500; display: inline-block;">
                            ${t('email_log_in_now')}
                        </a>
                    </div>
                </div>
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

app.get('/profile', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    
    // Fetch all exhibitions to easily grab the user's specific lists
    const allExhibitions = await getParisExhibitions(userId);
    const attended = allExhibitions.filter(e => e.priority === 'Attended');
    const mustSee = allExhibitions.filter(e => e.priority === 'Must See');

    res.render('profile', { 
        user, 
        attended, 
        mustSee, 
        isPublic: false,
        host: req.get('host'),
        protocol: req.protocol
    });
});

app.get('/u/:username', async (req, res) => {
    const username = req.params.username;
    const profileUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    
    if (!profileUser) return res.status(404).send('Profile not found');

    const allExhibitions = await getParisExhibitions(profileUser.id);
    const attended = allExhibitions.filter(e => e.priority === 'Attended');
    const mustSee = allExhibitions.filter(e => e.priority === 'Must See');

    // We reuse the profile view, but pass a flag indicating it's the public version
    res.render('profile', { user: profileUser, attended, mustSee, isPublic: true });
});

app.get('/profile/edit', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.render('edit-profile', { user });
});

app.post('/profile/edit', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');

    let { name, username, city, picture_url } = req.body;
    let { name, username, city, picture_url, wants_digest } = req.body;
    
    // Sanitize username (lowercase, letters, numbers, and hyphens only)
    let formattedUsername = username ? username.toLowerCase().replace(/[^a-z0-9-]/g, '') : null;

    // Prevent collision if two users try to claim the exact same handle
    if (formattedUsername) {
        const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(formattedUsername, userId) as { id: number } | undefined;
        if (existing) formattedUsername = formattedUsername + Math.floor(Math.random() * 1000);
    }

    db.prepare('UPDATE users SET name = ?, username = ?, city = ?, picture_url = ? WHERE id = ?')
      .run(name || null, formattedUsername || null, city || 'Paris', picture_url || null, userId);
    const wantsDigestInt = wants_digest === 'on' ? 1 : 0;

    db.prepare('UPDATE users SET name = ?, username = ?, city = ?, picture_url = ?, wants_digest = ? WHERE id = ?')
      .run(name || null, formattedUsername || null, city || 'Paris', picture_url || null, wantsDigestInt, userId);

    res.redirect('/profile');
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
