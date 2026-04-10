
import db from './database.ts';
import * as fs from 'fs'; // if you still need fs for other things

export class Venue {
  id: string;
  name: string;
  isHighValue: boolean;

  constructor(name: string, highValueList: string[]) {
    this.name = name || "Unknown Venue";
    // Generate a consistent ID from the name
    this.id = this.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');

    // Logic that runs automatically on creation
    this.isHighValue = highValueList.some(v =>
      this.name.toLowerCase().includes(v.toLowerCase().trim())
    );
  }

  save() {
    const stmt = db.prepare(`
          INSERT OR REPLACE INTO venues (id, name, is_high_value)
          VALUES (?, ?, ?)
        `);
    // SQLite doesn't have Booleans, so we store 1 or 0
    stmt.run(this.id, this.name, this.isHighValue ? 1 : 0);
  }
}

export class Exhibition {
  id: string;
  title: string;
  venue: Venue;
  venueName: string; // For easier access in the UI
  venueId: string;
  startDate: Date;
  endDate: Date;
  priority: 'Must See' | 'Nice to See' | 'Ignore';
  isFree: boolean;
  coverUrl?: string;
  url: string;

  constructor(raw: any, venue: Venue) {
    this.id = raw.id?.toString();
    this.title = raw.title || "Untitled";
    this.venue
    this.venueId = venue.id;
    this.venueName = venue.name;
    this.startDate = new Date(raw.date_start);
    this.endDate = new Date(raw.date_end);
    this.url = raw.url || raw.contact_url;
    this.coverUrl = raw.cover_url;
    this.isFree = raw.price_type === 'gratuit';

    // Automatic Priority Logic
    this.priority = this.calculatePriority(raw, venue);
  }

  private calculatePriority(raw: any, venue: Venue): 'Must See' | 'Recommended' | 'Nice to See' | 'Ignore' {
    const title = this.title.toLowerCase();

    // Ignore rules (workshops/stages)
    if (title.includes("atelier") || title.includes("stage")) return 'Ignore';

    // Must See rules
    if (venue.isHighValue) return 'Recommended';

    return 'Nice to See';


  }
  save() {
    const stmt = db.prepare(`
          INSERT OR REPLACE INTO exhibitions (
            id, title, venue_id, start_date, end_date, priority, url, cover_url, is_free
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

    stmt.run(
      this.id,
      this.title,
      this.venueId,
      this.startDate.toISOString(),
      this.endDate.toISOString(),
      this.priority,
      this.url,
      this.coverUrl,
      this.isFree ? 1 : 0
    );
  }
}