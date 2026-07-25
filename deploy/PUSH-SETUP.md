# Turning on push notifications

The PWA (installable app + offline) works with no setup. **Push notifications** need one
set of keys added to the Node app.

## 1. Generate a VAPID key pair (once, on your PC)

In the `api` folder:

```
npx web-push generate-vapid-keys --json
```

It prints a `publicKey` and a `privateKey`. Keep them; the private one is a secret.

## 2. Add them to the Node app

cPanel > Setup Node.js App > Klippy > Environment variables:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the publicKey from step 1 |
| `VAPID_PRIVATE_KEY` | the privateKey from step 1 |
| `VAPID_SUBJECT` | `mailto:ruben@mondobase.com` |

Save, then **Restart** the app.

## 3. Turn it on per device

Each person enables it on each device they want alerts on:

1. Open Klippy, go to **Settings > Profile**.
2. Tick **Notify me on this device**, allow the browser prompt.
3. Hit **Send a test** to confirm it arrives.

Notifications fire when a card is **assigned to you** or **someone comments on your card**.

## Installing the app

- **Desktop (Chrome/Edge):** an install icon appears in the address bar, or menu >
  "Install Klippy".
- **Android:** Chrome shows "Add to Home screen".
- **iPhone/iPad:** Safari > Share > **Add to Home Screen**. Note: iOS only allows push
  notifications *after* the app is added to the Home Screen, then enable them in Settings
  > Profile from the installed app. This is an Apple restriction, not a Klippy one.

If push says "not switched on for this server", the VAPID keys in step 2 are missing or
the app wasn't restarted after adding them.
