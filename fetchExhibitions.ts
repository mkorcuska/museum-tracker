import { Exhibition, Venue } from './types.ts';
import * as fs from 'fs';
import db from './database'; // Notice: No curly braces!


const PARIS_API_URL = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records';

// Helper to load your venue list from the text file
function loadHighValueVenues(): string[] {
    try {
        const data = fs.readFileSync('high-value-venues.txt', 'utf-8');
        return data.split('\n').map(line => line.trim()).filter(l => l.length > 0);
    } catch (err) {
        return [];
    }
}

const CACHE_FILE = 'data.json';

export async function getParisExhibitions(userId?: number): Promise<Exhibition[]> {
    let rawResults: any[] = [];
    const highValueVenues = loadHighValueVenues();

    // 1. Get the RAW data (either from Cache or API)
    if (fs.existsSync(CACHE_FILE)) {
        console.log("📦 Loading from local cache...");
        rawResults = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }

    if (rawResults.length === 0) {
        console.log("🔄 Fetching fresh data...");
        // ... (Your existing while loop that fetches from the API) ...
        // After the loop finishes:
        rawResults = allResults;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(rawResults, null, 2));
    }

// ... (fetch rawResults logic remains exactly the same) ...

    const venuesMap = new Map<string, Venue>();
    
    // 2. Fetch User Preferences if logged in
    const userPrefs = userId ? 
        db.prepare('SELECT exhibition_id, priority FROM user_exhibitions WHERE user_id = ?').all(userId) : 
        [];
    
    // Convert to a Map for ultra-fast lookups
    const prefMap = new Map(userPrefs.map((p: any) => [p.exhibition_id, p.priority]));

    const exhibitions = rawResults.map(record => {
        const venueName = record.address_name || record.lieu || "Unknown Venue";
        if (!venuesMap.has(venueName)) {
            venuesMap.set(venueName, new Venue(venueName, highValueVenues));
        }
        
        // 3. Look up if the user tagged this specific exhibition
        const userTag = prefMap.get(record.id?.toString());
        
        // Pass the tag to the constructor
        return new Exhibition(record, venuesMap.get(venueName)!, userTag);
    });

    // Sort the results
    exhibitions.sort((a, b) => {
        // 1. Sort by Priority ('Must See' > 'Recommended' > 'Nice to See' > 'Ignore')
        const priorityOrder = { 'Must See': 0, 'Recommended': 1, 'Nice to See': 2, 'Ignore': 3 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];

        if (priorityDiff !== 0) {
            return priorityDiff;
        }

        // 2. If priorities are equal, sort by Closing Date (Soonest first)
        // We use .getTime() to compare the Date objects we created in the constructor
        return a.endDate.getTime() - b.endDate.getTime();
    });

    console.log(`✅ Successfully mapped ${exhibitions.length} exhibitions.`);

    return exhibitions;
}

