import { Exhibition, Venue } from './types.ts';
import * as fs from 'fs';
import db from './database'; // Notice: No curly braces!
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARIS_API_URL = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records';

// Helper to load your venue list from the text file
function loadHighValueVenues(): string[] {
    try {
        const data = fs.readFileSync(join(__dirname, 'high-value-venues.txt'), 'utf-8');
        return data.split('\n').map(line => line.trim()).filter(l => l.length > 0);
    } catch (err) {
        console.error("Warning: Could not load high-value-venues.txt", err);
        return [];
    }
}

const dataDir = process.env.DATA_DIR || '.';
const CACHE_FILE = join(dataDir, 'exhibitions_cache.json');
const TAGS_FILE = join(dataDir, 'all_api_tags.json');
const REJECTED_FILE = join(dataDir, 'rejected_cache.json');

// Easily modifiable array of keywords to filter exhibitions
export const VALID_KEYWORDS = ["expo", "peinture", "art contemporain", "beaux-arts", "photo", "exposition"];

export async function getParisExhibitions(userId?: number): Promise<Exhibition[]> {
    let rawResults: any[] = [];
    const highValueVenues = loadHighValueVenues();

    // 1. Get the RAW data (either from Cache or API)
    let needsFetch = true;
    if (fs.existsSync(CACHE_FILE)) {
        const stats = fs.statSync(CACHE_FILE);
        const ageInHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
        
        if (ageInHours < 24) {
            console.log("📦 Loading from local cache...");
            rawResults = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
            needsFetch = rawResults.length === 0;
        } else {
            console.log("🕰️ Cache is older than 24 hours. Refreshing...");
        }
    }

    if (needsFetch) {
        console.log("🔄 Fetching fresh data...");
        
        let allResults: any[] = [];
        let offset = 0;
        const limit = 100;
        let hasMore = true;
        let allUniqueTags = new Set<string>();
        let allRejected: any[] = [];

        while (hasMore) {
            // Fetch broadly without strict 'refine' to catch poorly tagged exhibitions
            const response = await fetch(`${PARIS_API_URL}?limit=${limit}&offset=${offset}`);
            
            if (!response.ok) {
                console.error(`API Error: ${response.status}`);
                break;
            }
            
            const data = await response.json();
            
            if (data.results && data.results.length > 0) {
                // Harvest all unique tags from the API for analysis
                data.results.forEach((r: any) => {
                    const tags = (r.qfap_tags || "").split(';');
                    tags.forEach((t: string) => {
                        if (t.trim()) allUniqueTags.add(t.trim());
                    });
                });

                const expos: any[] = [];
                data.results.forEach((r: any) => {
                    const tags = (r.qfap_tags || "").toLowerCase();
                    const title = (r.title || "").toLowerCase();
                    if (VALID_KEYWORDS.some(kw => tags.includes(kw) || title.includes(kw))) {
                        expos.push(r);
                    } else {
                        allRejected.push(r);
                    }
                });
                allResults = allResults.concat(expos);
                offset += limit;
            } else {
                hasMore = false;
            }
        }
        
        rawResults = allResults;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(rawResults, null, 2));
        
        // Save the harvested tags to a file for easy review
        fs.writeFileSync(TAGS_FILE, JSON.stringify(Array.from(allUniqueTags).sort(), null, 2));
        fs.writeFileSync(REJECTED_FILE, JSON.stringify(allRejected, null, 2));
    }

    const venuesMap = new Map<string, Venue>();
    
    // 2. Fetch User Preferences if logged in
    const userPrefs = userId ? 
        db.prepare('SELECT exhibition_id, priority FROM user_preferences WHERE user_id = ?').all(userId) : 
        [];
    
    // Convert to a Map for ultra-fast lookups
    const prefMap = new Map(userPrefs.map((p: any) => [p.exhibition_id, p.priority]));

    const userVenuePrefs = userId ?
        db.prepare('SELECT venue_id, is_favorite FROM user_favorite_venues WHERE user_id = ?').all(userId) :
        [];
    const venuePrefMap = new Map(userVenuePrefs.map((p: any) => [p.venue_id, p.is_favorite === 1]));

    // Wrap the heavy database insertions in a single transaction for a massive performance gain
    const mapAndSave = db.transaction(() => {
        return rawResults.map(record => {
            const venueName = record.address_name || record.lieu || "Unknown Venue";
            if (!venuesMap.has(venueName)) {
                const venue = new Venue(venueName, highValueVenues);
                venuesMap.set(venueName, venue);
                venue.save(); // Save the venue to the database
            }
            
            const baseVenue = venuesMap.get(venueName)!;
            const userVenue = Object.create(baseVenue);
            Object.assign(userVenue, baseVenue);
            if (venuePrefMap.has(userVenue.id)) {
                userVenue.isHighValue = venuePrefMap.get(userVenue.id)!;
            }

            // 3. Look up if the user tagged this specific exhibition
            const userTag = prefMap.get(record.id?.toString());
            
            // Pass the tag to the constructor
            const exhibition = new Exhibition(record, userVenue, userTag);
            exhibition.save(); // Save the exhibition to the database
            return exhibition;
        });
    });
    
    let exhibitions = mapAndSave();

    // 4. Fetch Past History from DB
    // If a user marked an exhibition as 'Attended' or 'Must See', we want to keep it in their history
    // even if it has dropped off the live API.
    if (userId) {
        const processedIds = new Set(exhibitions.map(e => e.id));
        
        const pastExhibitions = db.prepare(`
            SELECT e.*, v.name as v_name, v.is_high_value as v_high_value, up.priority as user_priority
            FROM exhibitions e
            JOIN user_preferences up ON e.id = up.exhibition_id
            JOIN venues v ON e.venue_id = v.id
            WHERE up.user_id = ? AND up.priority IN ('Attended', 'Must See')
        `).all(userId) as any[];

        for (const row of pastExhibitions) {
            if (!processedIds.has(row.id)) {
                const venue = new Venue(row.v_name, []);
                venue.id = row.venue_id; // restore original deterministic ID
                venue.isHighValue = row.v_high_value === 1;

                const rawFake = {
                    id: row.id,
                    title: row.title,
                    date_start: row.start_date,
                    date_end: row.end_date,
                    url: row.url, 
                    cover_url: row.cover_url,
                    price_type: row.is_free ? 'gratuit' : 'payant'
                };
                const exhibition = new Exhibition(rawFake, venue, row.user_priority);
                exhibitions.push(exhibition);
                processedIds.add(row.id);
            }
        }
    }

    // Sort the results
    exhibitions.sort((a, b) => {
        // 1. Assign a rank based on custom filtering/sorting rules
        const getRank = (expo: Exhibition) => {
            if (!expo.isActive) {
                return expo.priority === 'Attended' ? 8 : 9; // Inactive history at bottom
            }
            if (expo.priority === 'Attended') return 7; // Active attended
            if (expo.isNew && expo.venue.isHighValue) return 1;
            if (expo.priority === 'Must See' && expo.isClosingSoon) return 2;
            if (expo.priority === 'Recommended' && expo.isClosingSoon) return 3;
            if (expo.priority === 'Must See') return 4;
            if (expo.priority === 'Recommended') return 5;
            if (expo.priority === 'Nice to See') return 6;
            return 10; // The rest ('Ignore' or unknown)
        };

        const rankDiff = getRank(a) - getRank(b);

        if (rankDiff !== 0) {
            return rankDiff;
        }

        // 2. If priorities are equal, sort by Closing Date (Soonest first)
        // We use .getTime() to compare the Date objects we created in the constructor
        return a.endDate.getTime() - b.endDate.getTime();
    });

    console.log(`✅ Successfully mapped ${exhibitions.length} exhibitions.`);
    
    const newExhibitionsCount = exhibitions.filter(e => e.isNew).length;
    console.log(`🎉 Found ${newExhibitionsCount} new exhibitions this week!`);
    const closingExhibitionsCount = exhibitions.filter(e => e.isClosingSoon).length;
    console.log(`🎉 Found ${closingExhibitionsCount} exhibitions closing soon!`);

    return exhibitions;
}
