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

const dataDir = process.env.DATA_DIR || '.';
const CACHE_FILE = `${dataDir}/data.json`;

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
        db.prepare('SELECT exhibition_id, priority FROM user_preferences WHERE user_id = ?').all(userId) : 
        [];
    
    // Convert to a Map for ultra-fast lookups
    const prefMap = new Map(userPrefs.map((p: any) => [p.exhibition_id, p.priority]));

    const userVenuePrefs = userId ?
        db.prepare('SELECT venue_id, is_favorite FROM user_favorite_venues WHERE user_id = ?').all(userId) :
        [];
    const venuePrefMap = new Map(userVenuePrefs.map((p: any) => [p.venue_id, p.is_favorite === 1]));

    const exhibitions = rawResults.map(record => {
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

    // Sort the results
    exhibitions.sort((a, b) => {
        // 1. Assign a rank based on custom filtering/sorting rules
        const getRank = (expo: Exhibition) => {
            if (expo.isNew && expo.venue.isHighValue) return 1;
            if (expo.priority === 'Must See' && expo.isClosingSoon) return 2;
            if (expo.priority === 'Recommended' && expo.isClosingSoon) return 3;
            if (expo.priority === 'Must See') return 4;
            if (expo.priority === 'Recommended') return 5;
            if (expo.priority === 'Nice to See') return 6;
            return 7; // The rest ('Ignore' or unknown)
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
