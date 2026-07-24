# One-time setup: Git-based deploys for Klippy

Goal: after this, shipping an update = I push code, you click one "Deploy" button
in cPanel. No zips, no phpMyAdmin, no npm. This setup is done once.

The repo is already prepared locally at C:\CC\klippy-v2 (committed, with a
`.cpanel.yml` deploy script and the built app included). We just need to (A) get it
onto GitHub, and (B) connect cPanel to it.

## A. Put the code on GitHub

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new **private** repository named `klippy` (no README, no .gitignore -
   leave it empty). Copy its URL, e.g. `https://github.com/YOURNAME/klippy.git`.
3. Getting our local code up there needs a push, which needs a GitHub credential.
   Easiest: create a **Personal Access Token** (GitHub > Settings > Developer
   settings > Personal access tokens > Fine-grained token, give it access to the
   `klippy` repo with Contents: Read/Write). Send it to me along with the repo URL,
   and I'll push the code up for you. (Or, if you use git yourself, run:
   `git remote add origin <url> && git push -u origin master`.)

## B. Connect cPanel to the repo

1. cPanel > **Git Version Control** > **Create**.
2. Toggle **Clone a Repository** on.
3. Clone URL: your repo's URL. For a private repo, cPanel will show an SSH key -
   copy it, then in GitHub go to the repo > Settings > Deploy keys > Add deploy key,
   paste it, save. (Public repo skips this.)
4. Repository Path: something like `/home/novelcom/repos/klippy`.
5. Create. cPanel clones the code.

## Deploying (every time after setup)

1. I push the new version to GitHub (you do nothing, or I tell you it's ready).
2. cPanel > Git Version Control > your repo > **Manage** > **Pull or Deploy** tab >
   **Update from Remote** (pulls my latest), then **Deploy HEAD Commit**.
3. That's it. `.cpanel.yml` copies the web + API files into place, installs any new
   packages, and restarts the app. The app migrates its own database on restart.

Verify after a deploy: `https://klippy.mondobase.com/api/v1/health` returns JSON, and
the site hard-refreshed shows the change.

## Important: the very first deploy
Before the first git deploy, import `reconcile-to-managed.sql` once in phpMyAdmin
(this switches the live database to self-managed). After that, never again.
