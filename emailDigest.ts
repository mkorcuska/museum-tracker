import 'dotenv/config';
import db from './database.ts';
import { getParisExhibitions } from './fetchExhibitions.ts';
import { Resend } from 'resend';
import { translations } from './translations.ts';

const resend = new Resend(process.env.RESEND_API_KEY);

interface User {
    id: number;
    email: string;
    lang: 'en' | 'fr';
}

function getUsersForDigest(): User[] {
    // Fetches all users who have opted-in to the weekly digest.
    return db.prepare('SELECT id, email, lang FROM users WHERE wants_digest = 1').all() as User[];
}

async function generateDigestHTMLForUser(user: User): Promise<string | null> {
    const t = (key: string) => translations[user.lang][key] || key;
    const exhibitions = await getParisExhibitions(user.id);

    // Filter logic (same as /admin/test-digest)
    const newFavorites = exhibitions.filter(e => 
        e.isNew && e.venue.isHighValue && e.priority !== 'Ignore' && e.priority !== 'Attended'
    );
    const closingSoon = exhibitions.filter(e => 
        e.isClosingSoon && (e.venue.isHighValue || e.priority === 'Must See') && 
        e.priority !== 'Ignore' && e.priority !== 'Attended' &&
        !newFavorites.some(nf => nf.id === e.id)
    );
    const seenIds = new Set([...newFavorites, ...closingSoon].map(e => e.id));
    const mustSee = exhibitions.filter(e => 
        e.priority === 'Must See' && !seenIds.has(e.id) && e.priority !== 'Ignore' && e.priority !== 'Attended'
    );

    if (newFavorites.length === 0 && closingSoon.length === 0 && mustSee.length === 0) {
        return null; // Don't send an empty email
    }

    // Generate HTML
    let html = `<div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">`;
    html += `<h2 style="text-align: center;">🎨 ${t('digest_title')}</h2><hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 20px;" />`;
    
    html += `<h3 style="color: #d73a49;">✨ ${t('digest_new_favorites')}</h3>`;
    if (newFavorites.length > 0) {
        newFavorites.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name}</p>`);
    } else {
        html += `<p style="color: #666;">${t('digest_no_new_favorites')} <a href="${process.env.BASE_URL}/?filter=new" style="color: #0366d6;">${t('digest_see_all_new')}</a></p>`;
    }

    html += `<h3 style="color: #d73a49; margin-top: 30px;">⏳ ${t('digest_closing_soon')}</h3>`;
    if (closingSoon.length > 0) {
        closingSoon.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name} <span style="color: #d73a49; font-size: 0.9em;">(Closes ${e.endDate.toLocaleDateString(user.lang)})</span></p>`);
    } else {
        html += `<p style="color: #666;">${t('digest_nothing_closing')}</p>`;
    }

    html += `<h3 style="color: #d73a49; margin-top: 30px;">🔥 ${t('digest_must_see')}</h3>`;
    if (mustSee.length > 0) {
        mustSee.forEach(e => html += `<p><b>${e.title}</b> at ${e.venue.name}</p>`);
        html += `<p style="font-size: 0.9em; font-style: italic; color: #555;">${t('digest_must_see_reminder')}</p>`;
    } else {
        html += `<p style="color: #666;">${t('digest_all_caught_up')}</p>`;
    }

    const unsubscribeLink = `${process.env.BASE_URL}/profile/edit`;
    html += `<div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center;">${t('digest_receiving_because')} <a href="${unsubscribeLink}" style="color: #999; text-decoration: underline;">${t('digest_unsubscribe')}</a></div></div>`;
    
    return html;
}

export async function sendWeeklyDigests() {
    console.log("Starting weekly digest job...");
    const users = getUsersForDigest();
    console.log(`Found ${users.length} users opted-in for digests.`);

    for (const user of users) {
        const t = (key: string) => translations[user.lang][key] || key;
        const htmlContent = await generateDigestHTMLForUser(user);

        if (htmlContent) {
            // In a real scenario, you would uncomment the resend.emails.send call
            console.log(`--- Digest for ${user.email} ---`);
            console.log("Subject:", t('digest_email_subject'));
            console.log("--- HTML would be sent ---");
        } else {
            console.log(`No relevant updates for ${user.email}. Skipping digest.`);
        }
    }
    console.log("Weekly digest job finished.");
}
import 'dotenv/config';
import db from './database.ts';
import { getParisExhibitions } from './fetchExhibitions.ts';
import { Resend } from 'resend';
import { translations } from './translations.ts';

const resend = new Resend(process.env.RESEND_API_KEY);

interface User {
    id: number;
    email: string;
    lang: 'en' | 'fr';
}

function getUsersForDigest(): User[] {
    // Fetches all users who have opted-in to the weekly digest.
    return db.prepare('SELECT id, email, lang FROM users WHERE wants_digest = 1').all() as User[];
}

async function generateDigestHTMLForUser(user: User): Promise<string | null> {
    const t = (key: string) => translations[user.lang][key] || key;
    const exhibitions = await getParisExhibitions(user.id);

    // Filter logic (same as /admin/test-digest)
    const newFavorites = exhibitions.filter(e => 
        e.isNew && e.venue.isHighValue && e.priority !== 'Ignore' && e.priority !== 'Attended'
    );
    const closingSoon = exhibitions.filter(e => 
        e.isClosingSoon && (e.venue.isHighValue || e.priority === 'Must See') && 
        e.priority !== 'Ignore' && e.priority !== 'Attended' &&
        !newFavorites.some(nf => nf.id === e.id)
    );
    const seenIds = new Set([...newFavorites, ...closingSoon].map(e => e.id));
    const mustSee = exhibitions.filter(e => 
        e.priority === 'Must See' && !seenIds.has(e.id) && e.priority !== 'Ignore' && e.priority !== 'Attended'
    );

    if (newFavorites.length === 0 && closingSoon.length === 0 && mustSee.length === 0) {
        return null; // Don't send an empty email
    }

    // Generate HTML
    const buttonStyle = "background-color: #f6f8fa; color: #24292e; border: 1px solid rgba(27, 31, 35, 0.15); padding: 8px 16px; font-size: 14px; font-weight: 500; text-decoration: none; border-radius: 6px; display: inline-block; margin: 4px;";
    let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #eaeaea; border-radius: 8px; color: #333; line-height: 1.5;">`;
    html += `<div style="text-align: center; margin-bottom: 25px;">`;
    html += `<img src="${process.env.BASE_URL}/SeeSomeArtLogo.png" alt="SeeSome.art" style="max-height: 40px; margin-bottom: 15px;" />`;
    html += `<h2 style="font-weight: 400; font-size: 20px; margin: 0; color: #111;">${t('digest_title')}</h2>`;
    html += `</div><hr style="border: 0; border-top: 1px solid #eaeaea; margin-bottom: 30px;" />`;
    
    html += `<h3 style="color: #111; font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; margin-top: 0;">${t('digest_new_favorites')}</h3>`;
    if (newFavorites.length > 0) {
        newFavorites.forEach(e => html += `<p style="margin: 0 0 10px 0;"><b>${e.title}</b> at ${e.venue.name}</p>`);
    } else {
        html += `<p style="color: #666;">${t('digest_no_new_favorites')}</p>`;
    }

    html += `<h3 style="color: #111; font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; margin-top: 30px;">${t('digest_closing_soon')}</h3>`;
    if (closingSoon.length > 0) {
        closingSoon.forEach(e => html += `<p style="margin: 0 0 10px 0;"><b>${e.title}</b> at ${e.venue.name} <span style="color: #666; font-size: 0.9em;">(Closes ${e.endDate.toLocaleDateString(user.lang)})</span></p>`);
    } else {
        html += `<p style="color: #666;">${t('digest_nothing_closing')}</p>`;
    }

    html += `<h3 style="color: #111; font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; margin-top: 30px;">${t('digest_must_see')}</h3>`;
    if (mustSee.length > 0) {
        mustSee.forEach(e => html += `<p style="margin: 0 0 10px 0;"><b>${e.title}</b> at ${e.venue.name}</p>`);
        html += `<p style="font-size: 0.9em; font-style: italic; color: #555;">${t('digest_must_see_reminder')}</p>`;
    } else {
        html += `<p style="color: #666;">${t('digest_all_caught_up')}</p>`;
    }

    // Add the CTA buttons
    html += `<div style="text-align: center; margin: 30px 0 10px 0; padding-top: 20px; border-top: 1px solid #eaeaea;">`;
    html += `<a href="${process.env.BASE_URL}/profile" style="${buttonStyle}">${t('digest_go_to_must_see')}</a>`;
    html += `<a href="${process.env.BASE_URL}/?filter=new" style="${buttonStyle}">${t('digest_see_all_new')}</a>`;
    html += `<a href="${process.env.BASE_URL}/?filter=closing" style="${buttonStyle}">${t('digest_go_to_closing_soon')}</a>`;
    html += `</div>`;

    const unsubscribeLink = `${process.env.BASE_URL}/profile/edit`;
    html += `<div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center;">${t('digest_receiving_because')} <a href="${unsubscribeLink}" style="color: #999; text-decoration: underline;">${t('digest_unsubscribe')}</a></div></div>`;
    
    return html;
}

export async function sendWeeklyDigests() {
    console.log("Starting weekly digest job...");
    const users = getUsersForDigest();
    console.log(`Found ${users.length} users opted-in for digests.`);

    for (const user of users) {
        const t = (key: string) => translations[user.lang][key] || key;
        const htmlContent = await generateDigestHTMLForUser(user);

        if (htmlContent) {
            // In a real scenario, you would uncomment the resend.emails.send call
            console.log(`--- Digest for ${user.email} ---`);
            console.log("Subject:", t('digest_email_subject'));
            console.log("--- HTML would be sent ---");
        } else {
            console.log(`No relevant updates for ${user.email}. Skipping digest.`);
        }
    }
    console.log("Weekly digest job finished.");
}