# Install Guide

## Chrome Load Unpacked

Chrome's "Load unpacked" button must point to the extension root directory. The selected directory must contain `manifest.json` directly inside it.

Correct:

```text
gemini-web-brancher-main/
  manifest.json
  src/
  README.md
```

Wrong:

```text
Downloads/
  gemini-web-brancher-main/
    manifest.json

gemini-web-brancher-main/
  gemini-web-brancher-main/
    manifest.json

gemini-web-brancher-main/src/
```

If Chrome says the manifest is missing or unreadable, open the folder you selected in your file manager. If you cannot see `manifest.json` immediately at that level, go one level deeper or choose a different folder.

## User Flow

1. Install the extension through `chrome://extensions`.
2. Open `https://gemini.google.com/app`.
3. Send a normal Gemini message.
4. Click `Branch` below the latest Gemini response.
5. Wait while the extension creates and reads Gemini's public share link automatically.
6. Type in the branch panel on the original page.
7. Use `Open` on a branch panel if you need to inspect the background branch tab.

## Privacy Reminder

Branch creation uses Gemini public share links. Do not use this extension with sensitive conversations.
