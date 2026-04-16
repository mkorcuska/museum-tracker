# Gemini AI Instructions for SeeSome.art (Museum Tracker)

## Project Overview
**SeeSome.art** is a curated tracker for the Paris art scene. It fetches exhibitions from the Open Data Paris API, supplements them with manually added exhibitions, and allows users to organize their feed into priorities (Must See, Recommended, Nice to See, Attended, Ignored).

## Tech Stack
- **Backend Framework:** Node.js with Express.js
- **Language:** TypeScript
- **Database:** SQLite3 (using the `better-sqlite3` synchronous driver)
- **Templating Engine:** EJS
- **Authentication:** Passwordless Magic Links via Email (using Resend)
- **Session Management:** `express-session` with `connect-sqlite3`

## Coding Guidelines

### 1. TypeScript & Node
- Use modern ES6+ syntax and TypeScript features.
- Prefer explicitly defining types over using `any`.
- Ensure imports include the `.ts` extension where necessary for your current module resolution setup (e.g., `import { Venue } from './types.ts';`).

### 2. Database (`better-sqlite3`)
- The database is synchronous. Use `db.prepare('SQL').get()`, `.all()`, or `.run()`.
- **Always** use parameterized queries (e.g., `WHERE id = ?`) to prevent SQL injection.
- For bulk inserts/updates, wrap them in a `db.transaction(() => { ... })` for performance.

### 3. Architecture & State
- **Localization:** The app supports English and French. Always use the translation helper `t('key')` from `translations.ts` rather than hardcoding UI text.
- **Caching:** To avoid hitting the Paris API limits, raw exhibition data is cached locally in JSON format (`exhibitions_cache.json`). Respect this cache lifecycle (currently 24 hours).
- **Session State:** User session is accessed via `req.session.userId`. Global variables for EJS templates are set in the main middleware (e.g., `res.locals.lang`, `res.locals.t`).

### 4. Key Domain Concepts
- **Exhibitions:** Core entity. Has dynamic states like `isActive`, `isNew` (updated in the last 7 days), and `isClosingSoon` (closing in the next 14 days).
- **Venues:** Venues can be marked as "high value" (favorites). This affects sorting and prioritizing logic.
- **Magic Links:** Avoid standard password auth logic. Users enter an email, receive a secure token generated via `crypto`, which creates a session upon clicking.

## How to Assist Me
- When writing code, mimic the existing style (e.g., use standard `function` declarations for top-level exports if that's what the file currently uses).
- Keep external dependencies to a minimum unless necessary.
- When modifying UI, ensure changes are reflected in both the `en` and `fr` dictionaries in `translations.ts`.
- When creating HTML, keep the style modern and elegant. Avoid the use of emojis, bright colors, and other distractions. The focus should be on the art and on actions the user can take.