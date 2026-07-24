# Klippy Quick Add (Chrome / Edge extension)

Capture any page as a Klippy card, and see what is due today, without opening the app.

## Install (unpacked, takes 1 minute)

1. In Klippy: **Settings > Tokens > Create**, name it "Browser extension", and copy the
   token (it is shown once).
2. In Chrome go to `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this `extension` folder.
5. Click the Klippy icon in the toolbar, paste your token, and hit **Connect**.

Pin it to the toolbar so it is one click away.

## What it does

- **Quick add**: the popup pre-fills the card title with the page title and drops the URL
  into the notes. Pick a board, priority and due date, then add.
- **Right-click > Add to Klippy**: adds the page (or the text you selected) straight to
  your last used board. No popup needed.
- **Due today**: the popup lists what is due today and what is overdue.

## Notes

- Auth uses an API token, not your login cookie: browser extensions run on their own
  origin so cookies are not sent. Revoke a token any time in Settings > Tokens.
- The extension only talks to the host in `manifest.json` (`host_permissions`). If you
  move Klippy to a different domain, update that value and the default in `popup.js`.
- No icon file is included; Chrome shows a default. Drop a 128x128 `icon128.png` in this
  folder to brand it.
