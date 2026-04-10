import express from 'express';
// Keep all your existing imports (database, etc.) here
import { saveExhibitionsToDB, getAllEventsFromDB } from './database'; 
import { getParisExhibitions } from './fetchExhibitions.ts';
import { renderHTML } from './uiux.ts';
import { generateMagicToken } from './auth';
import db from './database'; 

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


app.post('/update-priority', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).send("Log in first");

    const { exhibitionId, priority } = req.body;
    
    try {
        db.prepare(`
            INSERT INTO user_exhibitions (user_id, exhibition_id, priority) 
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, exhibition_id) DO UPDATE SET priority = excluded.priority
        `).run(userId, exhibitionId, priority);
        
        res.sendStatus(200);
    } catch (err) {
        console.error("DB Error saving priority:", err);
        // If it's a foreign key error, it usually throws a specific code
        res.status(500).send("Database error");
    }
});

app.get('/', async (req, res) => {
    // 1. Get the current logged-in user
    const currentUserId = req.session.userId;

    // 2. Pass it into the function!
    const exhibitions = await getParisExhibitions(currentUserId);

    res.render('index', { 
        exhibitions, 
        userId: currentUserId 
    }); 
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

