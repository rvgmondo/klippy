import 'dotenv/config';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy api/.env.example to api/.env.');
}

// A shared pool. Under cPanel Passenger this lives for the life of the process.
export const pool = mysql.createPool({
  uri: url,
  connectionLimit: 10,
  timezone: 'Z', // store/read everything in UTC, matching v1 behaviour
});

export const db = drizzle(pool, { schema, mode: 'default' });
export { schema };
