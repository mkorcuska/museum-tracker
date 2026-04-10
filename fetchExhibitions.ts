import * as fs from 'fs';
import { Exhibition, Venue } from './types.ts';

const CACHE_FILE = 'raw_data.json';
const PARIS_API_URL = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records';

async function fetchAllEvents() {
    let allEvents = [];
    let offset = 0;
    const limit = 100;
    let moreDataAvailable = true;

    while (moreDataAvailable) {
        // 1. Fetch the current "window" of data
        const response = await fetch(`${PARIS_API_URL}?limit=${limit}&offset=${offset}`);
        const data = await response.json();

        // 2. Add this batch to your collection
        const currentBatch = data.events;
        allEvents = [...allEvents, ...currentBatch];

        // 3. Check: Did we get a full page?
        // If we got 100, there's likely another page.
        // If we got 7 (the remainder of 407), we're done!
        if (currentBatch.length === limit && allEvents.length < data.total_count) {
            offset += limit;
        } else {
            moreDataAvailable = false;
        }
    }

    return allEvents;
}

async function refreshLocalEvents() {
    const STORAGE_KEY = 'cached_events';
    const TIMESTAMP_KEY = 'events_last_fetched';

    // 1. Check if we actually need to fetch (your existing logic)
    if (!isDataStale(TIMESTAMP_KEY)) {
        return JSON.parse(localStorage.getItem(STORAGE_KEY));
    }

    // 2. Data is stale, let's paginate
    let allEvents = [];
    let offset = 0;
    const limit = 100;
    let totalCount = Infinity; // Start high until we get the real number

    try {
        while (allEvents.length < totalCount) {
            const response = await fetch(`api_url?limit=${limit}&offset=${offset}`);
            const data = await response.json();

            totalCount = data.total_count; // API tells us the goalposts
            allEvents = [...allEvents, ...data.events];
            offset += limit;

            // Safety: Stop if the API returns an empty array to prevent infinite loops
            if (data.events.length === 0) break;
        }

        allEvents.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        // 3. Save to local storage
        localStorage.setItem(STORAGE_KEY, JSON.stringify(allEvents));
        localStorage.setItem(TIMESTAMP_KEY, Date.now().toString());

        return allEvents;
    } catch (error) {
        console.error("Failed to hydrate events:", error);
        // Fallback: return old data if fetch fails
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    }
}

/**
 * HELPER: The "Pure" Fetcher
 * Just talks to the network and returns raw JSON.
 */
async function fetchRawDataFromParis(limit: number): Promise<any> {
    const today = new Date().toISOString().split('T')[0];

    // 1. The Simplest Net: Just the word "exposition" and the date.
    // This is the query that gave us 397 results.
    const query = `search("exposition") AND date_end >= "${today}"`;

    const params = new URLSearchParams({
        // Note the 'ie' at the end of categorie
        where: 'categorie="Expositions"', 
        limit: limit.toString(),
        offset: offset.toString(),
        // 'date_debut' is the French field for start_date if you want to order it
        order_by: 'date_debut asc' 
    });

    const url = `${PARIS_API_URL}?${params.toString()}`;
    console.log("🌐 Calling API with Simple Search...");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`API Error: ${response.status}`);

    const data = await response.json();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    return data;
}

/**
 * HELPER: The Mapper
 * Transforms messy API records into our clean Exhibition interface.
 */
// Then update mapToExhibitions:
function mapToExhibitions(results: any[], highValueVenues: string[]): Exhibition[] {
    // 1. Create a "Lookup Table" (Map) to avoid creating the same Venue twice
    const venuesMap = new Map<string, Venue>();

    // 2. Use .map() to transform each raw API record into an Exhibition instance
    return results.map((record: any) => {
        const venueName = record.address_name || "Unknown Venue";

        // 3. VENUE LOGIC: If we haven't seen this venue in this batch, create it
        if (!venuesMap.has(venueName)) {
            const newVenue = new Venue(venueName, highValueVenues);
            venuesMap.set(venueName, newVenue);
        }

        // Get the venue object (we use ! because we know it exists now)
        const venue = venuesMap.get(venueName)!;

        // 4. EXHIBITION LOGIC: Create the instance using our Class constructor
        // This automatically calculates priority, dates, and flags
        return new Exhibition(record, venue);
    });
}

// Helper to load the venues, handle missing file, and clean up whitespace
function loadHighValueVenues(): string[] {
    try {
        const data = fs.readFileSync('high-value-venues.txt', 'utf-8');
        return data.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    } catch (err) {
        console.warn("⚠️ No high-value-venues.txt found, using empty list.");
        return [];
    }
}

/**
 * MAIN FUNCTION: The Orchestrator
 * Decides whether to use the cache or hit the network.
 */

export async function getParisExhibitions() {
    let allEvents: any[] = [];
    let offset = 0;
    const limit = 100;
    let totalCount = Infinity;

    try {
        while (allEvents.length < totalCount) {
            // No 'where' clause - just get the raw records
            const params = new URLSearchParams({
                limit: limit.toString(),
                offset: offset.toString()
            });

            const response = await fetch(`${PARIS_API_URL}?${params.toString()}`);
            const data = await response.json();

            totalCount = data.total_count;
            
            // FILTER IN TYPESCRIPT: 
            // Look for anything that mentions "Expositions" in the tags or category fields
            const batch = data.results.filter((item: any) => 
                JSON.stringify(item).toLowerCase().includes("exposition")
            );

            allEvents = [...allEvents, ...batch];
            console.log(`Matched ${allEvents.length} exhibitions out of ${offset + data.results.length} total events`);

            if (data.results.length < limit) break;
            offset += limit;
        }
        return allEvents;
    } catch (error) {
        console.error("❌ Fetch failed:", error);
        return [];
    }
}
