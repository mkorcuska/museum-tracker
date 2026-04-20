
import db from './database.ts';
import * as fs from 'fs'; // if you still need fs for other things
import crypto from 'crypto';

/** The threshold in days below which an exhibition is automatically ignored (unless at a high-value venue) */
export const SHORT_DURATION_IN_DAYS = 10;

export interface NormalizedVenue {
  name: string;
  city: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

export class Venue {
  id: string;
  name: string;
  city: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  isHighValue: boolean;

  constructor(data: NormalizedVenue, highValueList: string[]) {
    this.name = data.name || "Unknown Venue";
    this.city = data.city || 'Paris';
    this.address = data.address || null;
    this.latitude = data.latitude || null;
    this.longitude = data.longitude || null;
    
    // Generate a consistent ID from the name. Keep backwards compatibility for existing Paris venues.
    const cleanName = this.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
    this.id = this.city.toLowerCase() === 'paris' ? cleanName : `${this.city.toLowerCase()}-${cleanName}`;

    // Logic that runs automatically on creation
    this.isHighValue = highValueList.some(v =>
      this.name.toLowerCase().includes(v.toLowerCase().trim())
    );
  }

  save() {
    const stmt = db.prepare(`
          INSERT INTO venues (id, name, city, address, latitude, longitude, is_high_value)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            city = excluded.city,
            address = excluded.address,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            is_high_value = excluded.is_high_value
        `);
    stmt.run(this.id, this.name, this.city, this.address, this.latitude, this.longitude, this.isHighValue ? 1 : 0);
  }
}

export function generateMagicToken(email: string): string {
  // Find or create the user
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  
  if (!user) {
      const result = db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
      user = { id: result.lastInsertRowid as number };
  }
  
  // Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  
  // Set expiration (1 hour from now)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1);
  
  // Save the token to the database
  db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt.toISOString());
  
  return token;
}

export interface NormalizedExhibition {
  id: string;
  title: string;
  startDate: Date;
  endDate: Date;
  url: string;
  coverUrl?: string;
  isFree: boolean;
  updatedAt?: Date;
  city: string;
}

export class Exhibition {
  id: string;
  title: string;
  venue: Venue;
  venueName: string; // For easier access in the UI
  venueId: string;
  startDate: Date;
  endDate: Date;
  priority: 'Must See' | 'Recommended' | 'Nice to See' | 'Attended' | 'Ignore' | 'Unprioritized';
  isFree: boolean;
  coverUrl?: string;
  url: string;
  isNew: boolean;
  isClosingSoon: boolean;
  isActive: boolean;
  city: string;

  constructor(data: NormalizedExhibition, venue: Venue, userTag?: 'Must See' | 'Recommended' | 'Nice to See' | 'Attended' | 'Ignore' | 'Unprioritized' | string) {
    this.id = data.id;
    this.title = data.title;
    this.venue = venue;
    this.venueId = venue.id;
    this.venueName = venue.name;
    this.startDate = data.startDate;
    this.endDate = data.endDate;
    this.url = data.url;
    this.coverUrl = data.coverUrl;
    this.isFree = data.isFree;
    this.city = data.city;
    
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    this.isActive = this.endDate >= todayStart;

    // Check if added/updated in the API in the last 7 days
    const updatedDate = data.updatedAt || new Date(0);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    this.isNew = !userTag && (updatedDate > sevenDaysAgo);

    // Check if closing within the next 14 days
    const fourteenDaysFromNow = new Date(now);
    fourteenDaysFromNow.setDate(now.getDate() + 14);
    this.isClosingSoon = this.endDate >= now && this.endDate <= fourteenDaysFromNow;

    // If the user manually tagged this, use their tag. Otherwise, calculate it automatically.
    if (userTag) {
      this.priority = userTag as any;
    } else {
      this.priority = this.calculatePriority(venue);
    }
  }

  private calculatePriority(venue: Venue): 'Must See' | 'Recommended' | 'Nice to See' | 'Ignore' | 'Attended' | 'Unprioritized' {
    const title = this.title.toLowerCase();

    // Ignore rules (workshops/stages)
    if (title.includes("atelier") || title.includes("stage")) return 'Ignore';

    // Ignore short-duration events (less than SHORT_DURATION_IN_DAYS days) unless they are at high-value venues
    const durationInDays = (this.endDate.getTime() - this.startDate.getTime()) / (1000 * 60 * 60 * 24);
    if (durationInDays < SHORT_DURATION_IN_DAYS && !venue.isHighValue) {
      return 'Ignore';
    }

    // Must See rules
    if (venue.isHighValue) return 'Recommended';

    return 'Unprioritized';
  }
  save() {
    const stmt = db.prepare(`
          INSERT INTO exhibitions (
            id, title, venue_id, start_date, end_date, priority, url, cover_url, is_free, city
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            venue_id = excluded.venue_id,
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            url = excluded.url,
            cover_url = excluded.cover_url,
            is_free = excluded.is_free,
            city = excluded.city
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
      this.isFree ? 1 : 0,
      this.city
    );
  }
}