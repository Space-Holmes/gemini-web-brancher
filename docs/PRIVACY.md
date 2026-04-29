# Privacy Notes

Gemini Web Brancher is a local browser extension prototype. It does not include any server-side component and does not intentionally transmit conversation content to any service other than Gemini Web itself.

The extension can still access sensitive data because it runs on Gemini Web pages:

- It can read visible Gemini conversation text.
- It can create Gemini public share links when the user clicks Branch.
- It can read the clipboard to detect a Gemini public share link copied by Gemini's share UI.
- It stores branch metadata and recent mirrored output in `chrome.storage.local`.
- It opens background Gemini tabs to continue branch conversations.

Do not use this extension with private, regulated, confidential, or otherwise sensitive chats.

Before any public release, add a formal Chrome Web Store privacy policy, minimize permissions further where possible, and document the public-link behavior in onboarding UI.
