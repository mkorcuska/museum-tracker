import { Exhibition, Venue } from './types.ts';
import * as fs from 'fs';

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

export async function getParisExhibitions(): Promise<Exhibition[]> {
    let allResults: any[] = [];
    const highValueVenues = loadHighValueVenues();

    // --- CACHE CHECK START ---
    if (fs.existsSync(CACHE_FILE)) {
        console.log("📦 Loading from local cache (data.json)...");
        try {
            allResults = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        } catch (err) {
            console.error("Failed to read cache, fetching fresh data instead.");
        }
    }
    // --- CACHE CHECK END ---

    // Only run the API loop if we don't have results from the cache
    if (allResults.length === 0) {
        let offset = 0;
        const limit = 100;
        console.log("🔄 Fetching fresh data from Paris API...");

        try {
            while (true) {
                const today = new Date().toISOString().split('T')[0];
                const query = encodeURIComponent(`"exposition" AND date_end >= "${today}"`);
                const url = `${PARIS_API_URL}?where=${query}&limit=${limit}&offset=${offset}&order_by=date_start%20asc`;

                console.log(`🌐 Fetching: offset ${offset}...`);
                const response = await fetch(url);
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error("API Response Error:", errorText);
                    throw new Error(`API Error: ${response.status}`);
                }
                
                const data = await response.json();
                const batch = data.results || [];
                allResults = [...allResults, ...batch];
                console.log(`Current count: ${allResults.length}`);

                if (batch.length < limit || allResults.length >= data.total_count) break;
                offset += limit;
            }

            // Save the raw results so we don't hit the API again next time
            fs.writeFileSync(CACHE_FILE, JSON.stringify(allResults, null, 2));

        } catch (error) {
            console.error("❌ Orchestrator failed:", error);
            return [];
        }
    }

    // Always run the mapping part so your classes (Priority, Venue, etc.) are fresh
    const venuesMap = new Map<string, Venue>();
    const exhibitions = allResults.map(record => {
        const venueName = record.address_name || "Unknown Venue";
        if (!venuesMap.has(venueName)) {
            venuesMap.set(venueName, new Venue(venueName, highValueVenues));
        }
        return new Exhibition(record, venuesMap.get(venueName)!);
    });

    console.log(`✅ Successfully processed ${exhibitions.length} exhibitions.`);
    return exhibitions;
}

