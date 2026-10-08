# AGENTS.md

## Cursor Cloud specific instructions

This repository is the **V17 application form** ("Apply"). It has three parts, only some of which run locally:

| Component | Path | Runs locally? | Notes |
| --- | --- | --- | --- |
| Application form (frontend) | `index.html` | Yes (static) | Self-contained HTML/JS. Serve it and open in a browser. |
| Telegram bot | `telegram-bot/bot.py` | Partially | Runs the same filter/questionnaire as the web form. Needs a real `TELEGRAM_TOKEN` to actually poll Telegram. |
| Backend | `google-apps-script.js` | No | Runs on Google Apps Script (Google's platform), not locally. `tilda-*.html` are just embed snippets. |

The Python venv for the bot lives at `telegram-bot/.venv` and is (re)created by the startup update script. Activate it with `source telegram-bot/.venv/bin/activate` before running bot commands.

### Frontend form (`index.html`)
- Serve it from the repo root, e.g. `python3 -m http.server 8000`, then open `http://localhost:8000/index.html`.
- The core flow is the two-step **Quick Fit Check** filter (Segment / Stage / MRR / Markets) which gates the full questionnaire. All gating logic is client-side JS, so it works fully offline.
- On load the page fetches config (MRR thresholds, verticals) from the Google Apps Script `SUBMIT_URL`. If that request fails it silently falls back to hardcoded defaults — the form still works.
- **Do NOT actually submit the form during testing.** `SUBMIT_URL` points at the client's live production Google Apps Script (writes to their Sheets, Notion CRM, and Telegram). Demonstrate up to the questionnaire opening instead of submitting.

### Telegram bot (`telegram-bot/`)
- Tests need no token or network: `source .venv/bin/activate && python -m unittest test_flow` (34 tests). Use this as the lint/regression check — there is no separate linter configured.
- `python bot.py` exits with `TELEGRAM_TOKEN is not set` unless the `TELEGRAM_TOKEN` env var (a secret) is provided. It also reads optional `SUBMIT_URL` and `PROXY_URL` (both have production defaults baked in). To run the bot end-to-end you need a real bot token; without it, rely on the unit tests.

### System dependency note
- Creating the Python venv requires the `python3.12-venv` apt package (installed once during environment setup). Do not put system-package installs in the startup update script.
