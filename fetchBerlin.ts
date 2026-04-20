import { Exhibition, Venue, NormalizedVenue, NormalizedExhibition } from './types.ts';
import * as fs from 'fs';
import db from './database';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BERLIN_API_BASE_URL = 'https://api-v2.kulturdaten.berlin/api';
const EXHIBITION_CATEGORY_ID = '1'; // "Ausstellung" in the Kulturdaten API

const dataDir = process.env.DATA_DIR || '.';
const CACHE_FILE = join(dataDir, 'berlin_cache.json');

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

async function fetchAndNormalizeBerlinData(): Promise<{ exhibition: NormalizedExhibition, venue: NormalizedVenue }[]> {
    console.log("🔄 Fetching fresh data from Kulturdaten Berlin...");
    
    const allEvents: any[] = [];
    let hasMore = true;
    let page = 1;
    const today = new Date().toISOString().split('T')[0];

    // Smart pagination: only fetch events starting within the next 3 months
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() + 3);

    while (hasMore) {
        const queryParams = new URLSearchParams({
            'pageSize': '100',
            'page': page.toString()
        });
        
        const url = `${BERLIN_API_BASE_URL}/events/search?${queryParams.toString()}`;
        console.log(`Fetching ${url}`);

        const searchPayload = {
            byAttractionTags: {
                tags: ["attraction.category.Exhibitions"],
                matchMode: "any"
            },
            inTheFuture: true
        };

        try {
            let response: Response | null = null;
            let retries = 3;
            while (retries > 0) {
                try {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'User-Agent': 'MuseumTracker/1.0 (Node.js)'
                        },
                        body: JSON.stringify(searchPayload)
                    });
                    break;
                } catch (e: any) {
                    console.log(`Fetch failed, retrying... (${retries - 1} attempts left). Error: ${e.message}`);
                    retries--;
                    if (retries === 0) throw e;
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retrying
                }
            }
            
            if (!response || !response.ok) {
                console.error(`Kulturdaten API Error: ${response?.status}`);
                break;
            }
            const data = await response.json();
            if (data.data && data.data.events && data.data.events.length > 0) {
                allEvents.push(...data.data.events);
                
                const lastEventDateStr = data.data.events[data.data.events.length - 1].schedule?.startDate;
                if (lastEventDateStr && new Date(lastEventDateStr) > cutoffDate) {
                    console.log(`Reached events beyond 3 months (${lastEventDateStr}). Stopping pagination.`);
                    hasMore = false;
                    break;
                }

                page++;
                if (page > 20) { // Safety fallback to prevent infinite loops (max 2000 events)
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }
        } catch (e) {
            console.error("Failed to fetch from Kulturdaten API", e);
            hasMore = false;
        }
    }
    console.log(`Found ${allEvents.length} raw events from Berlin.`);

    const locationIds = new Set<string>();
    allEvents.forEach(event => {
        event.locations?.forEach((loc: any) => {
            if (loc.referenceId) locationIds.add(loc.referenceId);
        });
    });

    if (locationIds.size === 0) return [];

    console.log(`Fetching ${locationIds.size} locations from Berlin in batches...`);
    const allPlaces: any[] = [];
    const locationIdArray = Array.from(locationIds);
    const batchSize = 50; // Fetch 50 at a time to keep URL short

    for (let i = 0; i < locationIdArray.length; i += batchSize) {
        const batch = locationIdArray.slice(i, i + batchSize);
        const placesParams = new URLSearchParams({
            'ids': batch.join(',')
        });
        const placesUrl = `${BERLIN_API_BASE_URL}/locations?${placesParams.toString()}`;
        console.log(`Fetching batch ${Math.floor(i / batchSize) + 1} of locations...`);

        try {
            let placesResponse: Response | null = null;
            let placesRetries = 3;
            while (placesRetries > 0) {
                try {
                    placesResponse = await fetch(placesUrl, {
                        headers: {
                            'Accept': 'application/json',
                            'User-Agent': 'MuseumTracker/1.0 (Node.js)'
                        }
                    });
                    if (!placesResponse.ok) {
                        throw new Error(`Kulturdaten API Error fetching places: ${placesResponse.status}`);
                    }
                    break; // Success
                } catch (e: any) {
                    console.log(`Places batch fetch failed, retrying... (${placesRetries - 1} attempts left). Error: ${e.message}`);
                    placesRetries--;
                    if (placesRetries === 0) throw e;
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            if (placesResponse) {
                const placesData = await placesResponse.json();
                const locationsList = placesData.data?.locations || placesData.data || [];
                allPlaces.push(...locationsList);
            }
        } catch (e) {
            console.error("Failed to fetch a batch of places from Kulturdaten API", e);
        }
    }

    const placesMap = new Map<string, any>();
    allPlaces.forEach((place: any) => placesMap.set(place.identifier || place.id, place));

    const normalizedResults: { exhibition: NormalizedExhibition, venue: NormalizedVenue }[] = [];
    for (const event of allEvents) {

        const titleDe = event.attractions?.[0]?.referenceLabel?.de || "Untitled";
        const locationId = event.locations?.[0]?.referenceId;

        if (!locationId) continue;

        const place = placesMap.get(locationId) || {};
        const venueName = place.title?.de || place.name || event.locations?.[0]?.referenceLabel?.de || "Unknown Venue";

        const lat = place.physicalAddress?.latitude || place.lat || place.latitude || 52.5200;
        const lon = place.physicalAddress?.longitude || place.lng || place.longitude || 13.4050;

        const venueData: NormalizedVenue = {
            name: venueName,
            city: 'Berlin',
            address: place.physicalAddress?.street || place.address || '',
            latitude: lat,
            longitude: lon,
        };



        const expoData: NormalizedExhibition = {
            id: `berlin-${event.identifier}`,
            title: titleDe,
            startDate: new Date(event.schedule?.startDate || new Date()),
            endDate: new Date(event.schedule?.endDate || event.schedule?.startDate || new Date()),
            url: '', // V2 events omit root URLs
            coverUrl: '', // V2 events omit root images
            isFree: event.admission?.ticketType === "ticketType.freeOfCharge",
            updatedAt: event.metadata?.updated ? new Date(event.metadata.updated) : new Date(),
            city: 'Berlin',
        };

        normalizedResults.push({ exhibition: expoData, venue: venueData });
    }

    return normalizedResults;
}

export async function getBerlinExhibitions(userId?: number): Promise<Exhibition[]> {
    let normalizedResults: { exhibition: NormalizedExhibition, venue: NormalizedVenue }[] = [];
    const highValueVenues = loadHighValueVenues();

    let needsFetch = true;
    if (fs.existsSync(CACHE_FILE)) {
        const stats = fs.statSync(CACHE_FILE);
        const ageInHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
        if (ageInHours < 24) {
            console.log("📦 Loading Berlin data from local cache...");
            normalizedResults = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
            needsFetch = normalizedResults.length === 0;
        } else {
            console.log("🕰️ Berlin cache is older than 24 hours. Refreshing...");
        }
    }

    if (needsFetch) {
        normalizedResults = await fetchAndNormalizeBerlinData();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(normalizedResults, null, 2));
    }

    const venuesMap = new Map<string, Venue>();
    const userPrefs = userId ? db.prepare('SELECT exhibition_id, priority FROM user_preferences WHERE user_id = ?').all(userId) : [];
    const prefMap = new Map(userPrefs.map((p: any) => [p.exhibition_id, p.priority]));
    const userVenuePrefs = userId ? db.prepare('SELECT venue_id, is_favorite FROM user_favorite_venues WHERE user_id = ?').all(userId) : [];
    const venuePrefMap = new Map(userVenuePrefs.map((p: any) => [p.venue_id, p.is_favorite === 1]));

    const mapAndSave = db.transaction(() => {
        return normalizedResults.map(record => {
            const { venue: venueData, exhibition: expoData } = record;
            if (!venuesMap.has(venueData.name)) {
                const venue = new Venue(venueData, highValueVenues);
                venuesMap.set(venueData.name, venue);
                venue.save();
            }
            const baseVenue = venuesMap.get(venueData.name)!;
            const userVenue = Object.create(baseVenue);
            Object.assign(userVenue, baseVenue);
            if (venuePrefMap.has(userVenue.id)) {
                userVenue.isHighValue = venuePrefMap.get(userVenue.id)!;
            }
            const userTag = prefMap.get(expoData.id);
            const exhibition = new Exhibition(expoData, userVenue, userTag);
            exhibition.save();
            return exhibition;
        });
    });
    
    let exhibitions = mapAndSave();

    if (userId) {
        const processedIds = new Set(exhibitions.map(e => e.id));
        const pastExhibitions = db.prepare(`
            SELECT e.*, v.name as v_name, v.is_high_value as v_high_value, up.priority as user_priority
            FROM exhibitions e
            JOIN user_preferences up ON e.id = up.exhibition_id
            JOIN venues v ON e.venue_id = v.id
            WHERE up.user_id = ? AND up.priority IN ('Attended', 'Must See') AND e.city = 'Berlin'
        `).all(userId) as any[];

        for (const row of pastExhibitions) {
            if (!processedIds.has(row.id)) {
                const venue = new Venue({ name: row.v_name, city: 'Berlin' }, []);
                venue.id = row.venue_id;
                venue.isHighValue = row.v_high_value === 1;
                const expoData: NormalizedExhibition = { id: row.id, title: row.title, startDate: new Date(row.start_date), endDate: new Date(row.end_date), url: row.url, coverUrl: row.cover_url, isFree: row.is_free === 1, city: 'Berlin' };
                exhibitions.push(new Exhibition(expoData, venue, row.user_priority));
                processedIds.add(row.id);
            }
        }
    }

    exhibitions.sort((a, b) => {
        const getRank = (expo: Exhibition) => {
            if (!expo.isActive) return expo.priority === 'Attended' ? 8 : 9;
            if (expo.priority === 'Attended') return 7;
            if (expo.isNew && expo.venue.isHighValue) return 1;
            if (expo.priority === 'Must See' && expo.isClosingSoon) return 2;
            if (expo.priority === 'Recommended' && expo.isClosingSoon) return 3;
            if (expo.priority === 'Must See') return 4;
            if (expo.priority === 'Recommended') return 5;
            if (expo.priority === 'Nice to See') return 6;
            if (expo.priority === 'Unprioritized') return 7;
            return 10;
        };
        const rankDiff = getRank(a) - getRank(b);
        if (rankDiff !== 0) return rankDiff;
        return a.endDate.getTime() - b.endDate.getTime();
    });

    console.log(`✅ Successfully mapped ${exhibitions.length} Berlin exhibitions.`);
    return exhibitions;
}