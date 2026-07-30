# Deploying Klippy v2 to cPanel

One subdomain serves everything: the React app as static files in the docroot, and the
Node API mounted at `/api` on the same subdomain (same-origin, so logins just work).
Wherever this says `klippy.YOURDOMAIN.com`, use the subdomain you chose.

## What you need in hand
- `deploy/klippy-web.zip` and `deploy/klippy-api.zip` (built by `bash scripts/make-deploy.sh`)
- `deploy/schema.sql`
- 15 minutes in cPanel

## 1. Create the subdomain
cPanel > Domains > Create a New Domain (or Subdomains on older cPanel).
- Domain: `klippy.YOURDOMAIN.com`
- Document root: accept the suggested folder (e.g. `klippy.YOURDOMAIN.com` or
  `public_html/klippy`). Note this path; it is your DOCROOT below.

Then cPanel > SSL/TLS Status: make sure the new subdomain gets an AutoSSL certificate
(click "Run AutoSSL" if it shows unsecured). Wait until it is green before testing
logins; the auth cookie is HTTPS-only in production.

## 2. Create the database
cPanel > MySQL Databases:
1. Create database: e.g. `klippy` (cPanel prefixes it, e.g. `youruser_klippy`).
2. Create user: e.g. `klippyapp` with a strong password. Save the password.
3. Add User To Database > ALL PRIVILEGES.

cPanel > phpMyAdmin > select the new database > Import > choose `schema.sql` > Go.
You should see 11 tables afterwards.

## 3. Create the Node.js app
cPanel > Setup Node.js App > Create Application:
- Node.js version: the highest available (20+ preferred).
- Application mode: Production.
- Application root: `klippy_api` (a folder in your home dir, NOT inside the docroot).
- Application URL: pick your subdomain and set the path to `api`
  (so the app answers at `https://klippy.YOURDOMAIN.com/api`).
- Application startup file: `app.js`
- Click Create, but do not start it yet.

Add environment variables (same screen, Add Variable):
| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `mysql://DBUSER:DBPASS@localhost:3306/DBNAME` (from step 2, with the cPanel prefixes) |
| `JWT_SECRET` | a long random string, 50+ characters. Do not reuse anything. |
| `UPLOAD_DIR` | `/home/YOURCPANELUSER/klippy_uploads` |

If the DB password contains characters like `@ : / # ?`, percent-encode them in
DATABASE_URL (e.g. `@` becomes `%40`), or just pick a password without those.

## 4. Upload the API
cPanel > File Manager > go to the `klippy_api` folder (created in step 3):
1. Upload `klippy-api.zip` and Extract it here. You should see `app.js`,
   `package.json`, `package-lock.json`, and a `dist/` folder.
2. Back in Setup Node.js App, open your app and click **Run NPM Install**.
3. Click **Restart** (or Start).

Test: open `https://klippy.YOURDOMAIN.com/api/v1/health` in a browser. You should see
`{"ok":true,"service":"klippy-api",...}`. If you get a Passenger error page instead,
open the app in Setup Node.js App and check the log it shows.

## 5. Upload the web app
cPanel > File Manager > go to the DOCROOT from step 1:
1. If cPanel put a default `index.html` or a `cgi-bin` there, you can delete the
   default index but LEAVE any `.htaccess` that mentions Passenger - that block is
   what routes `/api` to your Node app.
2. Upload `klippy-web.zip` and Extract it here. You should now have `index.html` and
   an `assets/` folder next to each other in the docroot.

## 6. First login
Open `https://klippy.YOURDOMAIN.com`, click "Create one", and sign up. That first
signup creates your real workspace. Everyone signing up gets their own isolated
workspace; from your own workspace you cannot see theirs and they cannot see yours.

## Updating later
1. On your PC: `bash scripts/make-deploy.sh` (or build `api` and `web` separately if
   you're on Windows without bash - `npm run build` in each folder).
2. Re-upload + extract `klippy-web.zip` into the docroot (overwrite).
3. If the API changed: re-upload + extract `klippy-api.zip` into `klippy_api`,
   then Restart the app in Setup Node.js App. Run NPM Install only if
   `package.json` changed.
4. If the database changed: **do nothing extra.** The API runs any pending
   migrations itself on startup (see `api/src/db/migrate.ts`), tracked in a
   `__drizzle_migrations` table - restarting the app in step 3 is enough.
   Do NOT also run the migration SQL by hand via phpMyAdmin; if you do, the
   app's own migration runner will try to run it again on next restart, get a
   "Duplicate column"/"Table already exists" error, and refuse to start
   (crashes the whole app - shows as a 503). If that already happened, fix it
   by manually inserting one row into `__drizzle_migrations` marking the
   latest migration's timestamp as applied, then restart again.

## Troubleshooting
- **App won't start / site shows 503**: Setup Node.js App > open your app > read the
  log. Two common causes:
  - `ERR_MODULE_NOT_FOUND` for a package (e.g. `dotenv`): node_modules is out of
    date - click **Run NPM Install**, then Restart.
  - `klippy-api migration failed: ... Duplicate column` or `... already exists`: a
    migration was applied twice - once by hand via phpMyAdmin, once by the app's
    own migration runner on boot. See point 4 above for the fix.
- **/api/v1/health works but login fails**: check SSL is active (step 1); the cookie
  requires HTTPS. Also confirm JWT_SECRET is set.
- **500 errors mentioning the database**: DATABASE_URL wrong (prefixed names!) or the
  user lacks privileges on the database.
- **Uploads fail**: create the `klippy_uploads` folder in your home directory via File
  Manager if it does not exist; confirm UPLOAD_DIR matches its full path.
- **Passenger page instead of the app**: startup file must be `app.js` and the
  `dist/` folder must exist inside `klippy_api` (it comes from the zip).
