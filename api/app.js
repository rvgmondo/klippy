/**
 * cPanel / Passenger entry point.
 * "Setup Node.js App" points its Application startup file here; Passenger
 * provides PORT via the environment and dist/server.js listens on it.
 */
import './dist/server.js';
