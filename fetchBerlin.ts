import { Exhibition, Venue, NormalizedVenue, NormalizedExhibition } from './types.ts';
import * as fs from 'fs';
import db from './database';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BERLIN_API_BASE_URL = 'https://api-v2.kulturdaten.berlin/api';

const dataDir = process.env.DATA_DIR || '.';
const CACHE_FILE = join(dataDir, 'berlin_cache.json');
const RAW_EVENTS_FILE = join(dataDir, 'berlin_raw_events.json');
const RAW_LOCATIONS_FILE = join(dataDir, 'berlin_raw_locations.json');
const RAW_ATTRACTIONS_FILE = join(dataDir, 'berlin_raw_attractions.json');

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

async function fetchOgImage(targetUrl: string): Promise<string> {
    if (!targetUrl) return '';
    try {
        const controller = new AbortController();
        // 4-second timeout so unresponsive websites don't freeze the sync
        const timeoutId = setTimeout(() => controller.abort(), 4000); 
        const res = await fetch(targetUrl, { 
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MuseumTrackerBot/1.0)' }
        });
        clearTimeout(timeoutId);
        if (!res.ok) return '';
        const html = await res.text();
        
        const candidates: string[] = [];

        // 1. Try JSON-LD structured data (often used by museums for events)
        const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
        if (jsonLdMatch) {
            for (const match of jsonLdMatch) {
                const inner = match.match(/>([\s\S]*?)<\/script>/i)?.[1];
                if (inner) {
                    try {
                        const parsed = JSON.parse(inner);
                        const items = Array.isArray(parsed) ? parsed : [parsed];
                        for (const item of items) {
                            if (!item.image) continue;
                            if (typeof item.image === 'string') candidates.push(item.image);
                            else if (typeof item.image.url === 'string') candidates.push(item.image.url);
                            else if (Array.isArray(item.image)) {
                                if (typeof item.image[0] === 'string') candidates.push(item.image[0]);
                                else if (item.image[0]?.url) candidates.push(item.image[0].url);
                            }
                        }
                    } catch (e) {}
                }
            }
        }

        // 2. Try Open Graph, Twitter, or Itemprop meta tags
        const metaRegex1 = /<meta[^>]+(?:property|name|itemprop)\s*=\s*["'](?:og:image|twitter:image|image)["'][^>]+content\s*=\s*["']([^"']+)["']/gi;
        const metaRegex2 = /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name|itemprop)\s*=\s*["'](?:og:image|twitter:image|image)["']/gi;
        
        for (const match of html.matchAll(metaRegex1)) {
            if (match[1]) candidates.push(match[1]);
        }
        for (const match of html.matchAll(metaRegex2)) {
            if (match[1]) candidates.push(match[1]);
        }

        // 3. Last resort: Try to grab actual image tags on the page
        const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
        for (const match of html.matchAll(imgRegex)) {
            if (match[1]) candidates.push(match[1]);
        }
                        
        // 4. Test candidates against blacklist and return the first valid absolute URL
        const blacklist = ['favicon', 'social', 'fallback', 'logo', 'default', 'icon', 'spinner', 'loader', 'blank'];
        
        for (let imgUrl of candidates) {
            if (!imgUrl) continue;
            if (imgUrl.endsWith('.svg') || imgUrl.endsWith('.gif')) continue; // Skip vector/animated UI elements
            
            imgUrl = imgUrl.replace(/&amp;/g, '&');
            
            // Resolve relative URLs using the robust URL constructor
            if (!imgUrl.startsWith('http')) {
                try {
                    imgUrl = new URL(imgUrl, targetUrl).href;
                } catch (e) {
                    continue;
                }
            }
            
            // If it passes the blacklist, return immediately
            if (!blacklist.some(b => imgUrl.toLowerCase().includes(b))) {
                return imgUrl;
            }
        }
        return '';
    } catch (e) {
        return ''; // Safely ignore fetch timeouts/errors
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
    cutoffDate.setMonth(cutoffDate.getMonth() + 4);

    while (hasMore) {
        const queryParams = new URLSearchParams({
            'pageSize': '50', // Reduced to prevent 502 Bad Gateway timeouts
            'page': page.toString()
        });
        
        const url = `${BERLIN_API_BASE_URL}/events/search?${queryParams.toString()}`;
        console.log(`Fetching ${url}`);

        const searchPayload = {
            inTheFuture: true,
            byAttractionTags: {
                tags: ["attraction.category.Art"],
                matchMode: "any"
            }
        };

        try {
            let response: Response | null = null;
            let retries = 5;
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
                    if (response.ok || response.status === 404) break;
                    throw new Error(`HTTP ${response.status}`);
                } catch (e: any) {
                    console.log(`Fetch failed, retrying... (${retries - 1} attempts left). Error: ${e.message}`);
                    retries--;
                    if (retries === 0) throw e;
                    const backoffDelay = (5 - retries) * 2000; // Progressive backoff: 2s, 4s, 6s, 8s
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
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

    // Group events by Attraction ID to find the true Start and End dates
    const groupedEvents = new Map<string, any>();
    for (const event of allEvents) {
        const attractionId = event.attractions?.[0]?.referenceId;
        if (!attractionId) continue;
        
        const eventStart = new Date(event.schedule?.startDate || new Date());
        const eventEnd = new Date(event.schedule?.endDate || event.schedule?.startDate || new Date());
        
        if (!groupedEvents.has(attractionId)) {
            groupedEvents.set(attractionId, { ...event, _minStart: eventStart, _maxEnd: eventEnd });
        } else {
            const existing = groupedEvents.get(attractionId)!;
            if (eventStart < existing._minStart) existing._minStart = eventStart;
            if (eventEnd > existing._maxEnd) existing._maxEnd = eventEnd;
        }
    }
    const uniqueEvents = Array.from(groupedEvents.values());
    console.log(`🗜️ Compressed ${allEvents.length} daily events into ${uniqueEvents.length} unique events.`);
    fs.writeFileSync(RAW_EVENTS_FILE, JSON.stringify(uniqueEvents, null, 2));

    // Exclude obvious non-exhibitions BEFORE fetching heavy details.
    const EXCLUDE_KEYWORDS = ["führung", "rundgang", "workshop", "konzert", "lesung", "vortrag", "party", "theater", "comedy", "kurs", "kino", "film", "gespräch", "diskussion", "tanz", "musik", "festival", "show", "kabarett", "orchester", "chor", "symphon", "slam", "poetry"];
    const BERLIN_KEYWORDS = ["ausstellung", "kunst", "galerie", "fotografie", "malerei", "skulptur", "museum", "exhibition"];
    
    const potentialEvents = uniqueEvents.filter(event => {
        const titleDe = event.attractions?.[0]?.referenceLabel?.de || "";
        const titleLower = titleDe.toLowerCase();
        
        if (EXCLUDE_KEYWORDS.some(kw => titleLower.includes(kw))) return false;
        
        // If it's a very short event (e.g. 1 day), it's likely not an exhibition unless explicitly named as one
        const durationInDays = (event._maxEnd.getTime() - event._minStart.getTime()) / (1000 * 60 * 60 * 24);
        if (durationInDays < 3 && !BERLIN_KEYWORDS.some(kw => titleLower.includes(kw))) {
            return false;
        }
        
        return true;
    });

    console.log(`🔍 Filtered down to ${potentialEvents.length} potential exhibitions.`);

    const locationIds = new Set<string>();
    const attractionIds = new Set<string>();
    potentialEvents.forEach(event => {
        event.locations?.forEach((loc: any) => {
            if (loc.referenceId) locationIds.add(loc.referenceId);
        });
        attractionIds.add(event.attractions[0].referenceId);
    });

    if (locationIds.size === 0) return [];

    // Helper function for fast, safe concurrent fetching with retries
    async function fetchInBatches(ids: string[], endpoint: string, name: string): Promise<any[]> {
        const allResults: any[] = [];
        const batchSize = 5; // Reduced batch size to prevent 502s
        console.log(`Fetching ${ids.length} ${name} in fast batches...`);
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            const promises = batch.map(async (id) => {
                let retries = 3;
                while (retries > 0) {
                    try {
                        const res = await fetch(`${BERLIN_API_BASE_URL}/${endpoint}/${id}`, { 
                            headers: { 'Accept': 'application/json', 'User-Agent': 'MuseumTracker/1.0' } 
                        });
                        if (res.ok) {
                            const data = await res.json();
                            return data.data || data;
                        }
                        if (res.status === 404) return null;
                        throw new Error(`HTTP ${res.status}`);
                    } catch (e) {
                        retries--;
                        if (retries > 0) await new Promise(r => setTimeout(r, 2000));
                    }
                }
                return null;
            });
            const results = await Promise.all(promises);
            allResults.push(...results.filter(Boolean));
            await new Promise(r => setTimeout(r, 500)); // Increased delay between batches
        }
        return allResults;
    }

    const allPlaces = await fetchInBatches(Array.from(locationIds), 'locations', 'locations');
    fs.writeFileSync(RAW_LOCATIONS_FILE, JSON.stringify(allPlaces, null, 2));
    const placesMap = new Map<string, any>();
    allPlaces.forEach(place => placesMap.set(place.identifier || place.id, place));
    allPlaces.forEach(placeContainer => {
        const place = placeContainer.location;
        if (place) {
            placesMap.set(place.identifier || place.id, place);
        }
    });

    const allAttractions = await fetchInBatches(Array.from(attractionIds), 'attractions', 'attractions');
    fs.writeFileSync(RAW_ATTRACTIONS_FILE, JSON.stringify(allAttractions, null, 2));
    const attractionsMap = new Map<string, any>();
    allAttractions.forEach(attr => attractionsMap.set(attr.identifier || attr.id, attr));

    allAttractions.forEach(attrContainer => {
        const attr = attrContainer.attraction;
        if (attr) {
            attractionsMap.set(attr.identifier || attr.id, attr);
        }
    });
    const normalizedResults: { exhibition: NormalizedExhibition, venue: NormalizedVenue }[] = [];
    for (const event of potentialEvents) {
        const attractionId = event.attractions[0].referenceId;
        const attraction = attractionsMap.get(attractionId) || {};
        const titleDe = attraction.title?.de || event.attractions?.[0]?.referenceLabel?.de || "Untitled";
        
        const locationId = event.locations?.[0]?.referenceId;

        if (!locationId) continue;

        const place = placesMap.get(locationId) || {};
        const venueName = place.title?.de || place.name || event.locations?.[0]?.referenceLabel?.de || "Unknown Venue";

        const lat = place.physicalAddress?.latitude || place.lat || place.latitude || 52.5200;
        const lon = place.physicalAddress?.longitude || place.lng || place.longitude || 13.4050;

        const venueData: NormalizedVenue = {
            name: venueName,
            city: 'Berlin',
            address: place.physicalAddress?.street || place.address?.streetAddress || (typeof place.address === 'string' ? place.address : ''),
            latitude: lat,
            longitude: lon,
        };

        // Robust URL extraction: look through typical Kulturdaten fields (contacts, website, url)
        const extractUrl = (obj: any) => {
            if (!obj) return '';
            if (typeof obj.website === 'string' && obj.website) return obj.website;
            if (typeof obj.url === 'string' && obj.url) return obj.url;
            if (Array.isArray(obj.externalLinks) && obj.externalLinks[0]?.url) return obj.externalLinks[0].url;
            if (Array.isArray(obj.contacts) && obj.contacts[0]?.url) return obj.contacts[0].url;
            if (obj.contact?.url) return obj.contact.url;
            return '';
        };

        let bestUrl = extractUrl(attraction) || extractUrl(event) || extractUrl(place) || '';
        if (bestUrl && !bestUrl.startsWith('http')) bestUrl = 'https://' + bestUrl;

        // Robust Image extraction: Kulturdaten often uses media arrays
        const extractImage = (obj: any) => {
            if (!obj) return '';
            if (Array.isArray(obj.media) && obj.media[0]) return obj.media[0].url || obj.media[0].fileUrl || '';
            if (Array.isArray(obj.images) && obj.images[0]) return obj.images[0].url || obj.images[0].fileUrl || '';
            if (obj.image?.url) return obj.image.url;
            return '';
        };

        let bestImage = extractImage(attraction) || extractImage(event) || extractImage(place) || '';

        // Fallback: Scrape Open Graph image from the website URL
        if (!bestImage && bestUrl) {
            bestImage = await fetchOgImage(bestUrl);
        }

        // Broaden isFree check
        const isFree = 
            event.admission?.ticketType?.toLowerCase().includes("free") ||
            attraction.admission?.ticketType?.toLowerCase().includes("free") ||
            false;

        const expoData: NormalizedExhibition = {
            id: `berlin-${attractionId}`,
            title: titleDe,
            startDate: event._minStart,
            endDate: event._maxEnd,
            url: bestUrl, 
            coverUrl: bestImage,
            isFree,
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

export async function rebuildBerlinMapping(): Promise<void> {
    console.log("🛠️ Rebuilding Berlin mapping from raw JSON files...");
    const normalizedResults = await fetchAndNormalizeBerlinData(true);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(normalizedResults, null, 2));
    console.log(`✅ Rebuilt berlin_cache.json with ${normalizedResults.length} exhibitions.`);
}