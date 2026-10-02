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
/**
 * The SESSION in UTC as well, not only the driver.
 *
 * `timezone: 'Z'` tells mysql2 how to read the strings it gets back, but MySQL turns
 * TIMESTAMP columns into strings in the session's time zone, which is the server's
 * own unless told otherwise. On a server set to South African time every created_at
 * came back two hours late: a message sent at 14:05 said 16:05. DATETIME columns
 * were never affected, which is why only some times on a page were wrong.
 */
pool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
});
export const db = drizzle(pool, { schema, mode: 'default' });
export { schema };
//# sourceMappingURL=client.js.map