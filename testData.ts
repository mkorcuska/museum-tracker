import * as fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, 'exhibitions_cache.json');

if (!fs.existsSync(CACHE_FILE)) {
    console.error("❌ Cache file not found. Run the server first to fetch data.");
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
console.log(`\n📊 Data Analysis Report`);
console.log(`======================`);
console.log(`Total Exhibitions Found: ${data.length}`);

// Count by venue
const venues: Record<string, number> = {};
data.forEach((e: any) => {
    const venue = e.address_name || e.lieu || "Unknown";
    venues[venue] = (venues[venue] || 0) + 1;
});

console.log(`\n🏛️  Top 10 Venues by Exhibition Count:`);
Object.entries(venues)
    .sort((a, b) => b[1] - a[1]) // Sort descending by count
    .slice(0, 10)
    .forEach(([venue, count]) => {
        console.log(`  - ${venue}: ${count}`);
    });

if (data.length < 30) console.warn(`\n⚠️ WARNING: Count seems very low (${data.length}). Check your VALID_KEYWORDS!`);
else if (data.length > 200) console.warn(`\n⚠️ WARNING: Count seems very high (${data.length}). Filter might be too broad.`);
else console.log(`\n✅ Exhibition count (${data.length}) is within a reasonable expected range.`);
