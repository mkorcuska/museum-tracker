async function testBerlinAttraction() {
    const BERLIN_API_BASE_URL = 'https://api-v2.kulturdaten.berlin/api';
    
    console.log("🔍 Fetching a few events to find a valid Attraction ID...");
    const eventRes = await fetch(`${BERLIN_API_BASE_URL}/events/search?pageSize=10`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ inTheFuture: true })
    });
    const eventData = await eventRes.json();
    
    const eventWithAttraction = eventData.data.events.find((e: any) => e.attractions && e.attractions.length > 0);
    const attractionId = eventWithAttraction?.attractions[0].referenceId;
    
    if (!attractionId) {
        console.log("❌ No attraction found in the first few events.");
        return;
    }
    
    console.log(`✅ Found Attraction ID: ${attractionId}. Fetching details...`);
    
    const attrRes = await fetch(`${BERLIN_API_BASE_URL}/attractions/${attractionId}`, {
        headers: { 'Accept': 'application/json' }
    });
    const attrData = await attrRes.json();
    
    console.log(JSON.stringify(attrData.data || attrData, null, 2));
}

testBerlinAttraction();
