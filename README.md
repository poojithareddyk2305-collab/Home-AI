# AI Chatbot

A ChatGPT/Claude-style AI chatbot built as a college project. FastAPI backend calling the Groq API, with a plain HTML/CSS/JS frontend (no build step).

## Features

**Chatting**
- **Streaming replies** with a Stop button
- **Web search with sources** — the model decides when to search, shows what it searched for, cites results inline as clickable `[1]` links, and lists them under the answer
- **More tools** — live weather for any city, and an exact calculator (safe expression parser, no `eval`)
- **Document creation** — ask for "a document about X", a report, guide or write-up and the bot writes it as a downloadable card with Preview and download as **Word (.docx)**, **PDF** and **Markdown**. It appears in the Files panel too.
- **Personas** — Default, Tutor, Coder, Interviewer, Writer, Concise; chosen per chat from the header
- **Edit and regenerate** — edit any message you sent and resend, or regenerate the last reply
- **Usage stats** — each reply shows time, tokens, tool calls and model; hover for first-token time and tokens/sec; the header shows total tokens used in the chat
- **Markdown and code** — tables, lists, syntax-highlighted code with Copy buttons

**Files**
- **Attachments** — text/code files, PDFs, and images (images go to the vision model automatically)
- **Files panel** — everything uploaded or generated in the current chat, with preview and download

**Voice**
- **Voice input** (mic button) and **read-aloud** (Listen button on replies) using the browser's built-in speech features

**Organisation**
- **Multiple chats** with rename, delete, and **search** across titles and message text
- **Export** a chat as Markdown, or as PDF through the browser's print dialog
- **Accounts and synced history** — optional sign-in stores your chats in a database on the server so they follow you across browsers and devices. Chats made as a guest are added to your account when you sign in.

**Other**
- System prompt settings, dark and light themes, and a creator profile card shown when someone asks who built the bot

## Setup

1. Create a virtual environment and install dependencies:

   ```bash
   python -m venv venv
   venv\Scripts\pip install -r requirements.txt
   ```

2. Create a `.env` file in the project root:

   ```
   GROQ_API_KEY=your_groq_api_key_here
   GROQ_MODEL=openai/gpt-oss-120b
   GROQ_VISION_MODEL=qwen/qwen3.8-27b
   TAVILY_API_KEY=optional_but_recommended
   ```

   Get a free Groq key at [console.groq.com/keys](https://console.groq.com/keys). `TAVILY_API_KEY` is optional; see "Web search reliability" below.

3. Run the server:

   ```bash
   venv\Scripts\uvicorn main:app --reload --port 8010
   ```

4. Open [http://localhost:8010](http://localhost:8010).

Weather (Open-Meteo) needs no key, and web search works without one by using DuckDuckGo. The first run creates `chatbot.db` (SQLite) next to `main.py`.

### Web search reliability

Without a key the bot reads DuckDuckGo's HTML results. That works for normal use, but DuckDuckGo rate-limits scripted traffic: after many searches in a short time it can answer with a bot-check page for a few minutes. The app spaces requests out, caches repeated queries for 10 minutes, and backs off when blocked. While search is blocked, the bot says so plainly instead of guessing, and works again once the block clears.

For consistently good results, add a free [Tavily](https://tavily.com) API key (about 1,000 searches a month on the free plan) as `TAVILY_API_KEY` in `.env` and restart. When set, it is used first and DuckDuckGo becomes the backup.

## Using the app

### Tools (search, weather, calculator)

The globe button in the input bar turns tools on or off (on by default). When on, the model chooses by itself whether to search, check the weather, or calculate, and you'll see a chip for each call. Tools are skipped automatically when a chat contains an image, because the vision model is used then.

Try: "What's the latest stable Python version?", "Weather in Kavali", "What is 18% of 2450?", "Give me a document about gaming laptops"

### Documents

Ask for a document, report, guide or write-up and the bot writes the whole thing itself (it does not go looking for an existing file). The card offers:

- **Preview** — read it in the chat
- **Word** — a formatted `.docx` built on the server (headings, lists, tables, links)
- **PDF** — opens your browser's print dialog; choose "Save as PDF" (on Windows, "Microsoft Print to PDF")
- **Markdown** — the raw `.md` file

If live search is unavailable, the document is written from general knowledge and says at the top that specs and prices must be verified. Document creation is part of the tools feature, so keep the globe button on.

### Personas and system prompt

The persona picker in the header changes how the assistant behaves for that chat. **Settings** edits the base system prompt for all chats; the persona is added on top of it.

### Editing and regenerating

Hover a message: **Edit** on yours resends from that point (later messages are replaced), **Regenerate** on the latest reply asks again.

### Attachments and the Files panel

| Type | How it's handled |
|---|---|
| Text/code (`.txt .md .csv .json .py .js .ts .java .sql .html .css .yml` and more) | Read in the browser and sent to the model as context |
| PDF | Text extracted in the browser with pdf.js (long files truncated at 30,000 characters) |
| Images (`.png .jpg .gif .webp`) | Sent to the vision model |

**Files** in the header lists uploads and code the assistant generated (`snippet-1.py`, ...). PDFs download as extracted `.txt`.

### Voice

- **Mic** needs a browser with the Web Speech API (Chrome or Edge) and microphone permission. It is hidden if unsupported.
- **Listen** reads a reply aloud with the browser's text-to-speech; click again to stop.

### Accounts

Click **Guest / Sign in** at the bottom of the sidebar. Passwords are hashed with scrypt; sessions use random tokens stored in the database and expire after 30 days. This is meant for a local or demo deployment: there is no email verification, password reset, or rate limiting, and you should put it behind HTTPS before exposing it publicly. Signing out clears chats from that browser (they stay on the server).

### Creator profile card

The profile shown for "who built you" style questions is the `CREATOR_PROFILE` dict at the top of `main.py`. Questions that trigger it are matched by `CREATOR_QUESTION_PATTERN`.

## Project structure

```
main.py             FastAPI app: /chat streaming with the tool loop, personas, accounts and chat-sync endpoints
tools.py            Web search, weather, calculator and document tool definitions
docgen.py           Markdown to Word (.docx) conversion
db.py               SQLite storage for users, tokens and synced chats
static/index.html   Page markup
static/styles.css   All styling (dark and light themes)
static/app.js       Frontend logic
requirements.txt    Python dependencies
.env                Your Groq key and model names (not committed)
chatbot.db          Created on first run (not committed)
```

## Notes and limits

- Guests keep chats in the browser's `localStorage`; signed-in users also sync to the server. A different port or browser is a different `localStorage`.
- Search queries go to DuckDuckGo and weather lookups to Open-Meteo. The Groq key never leaves the server.
- Without a Tavily key, web search scrapes DuckDuckGo, which is fine for a demo but can be rate-limited or change its markup. I also tested Bing, Brave and Yahoo as backups; they either refuse scripted requests or return irrelevant pages, so they are not used.
- Search answers are written as a short briefing: summary first, a table for prices or comparisons, `[n]` citation links, and a caveat. Sources appear underneath as a list, collapsed after three.
- There is deliberately no "run code" tool: executing model-written code on the server is unsafe without a real sandbox.
- If a model returns a 404, list the models your key can use with `client.models.list()`.

## Troubleshooting

- **Backend changes don't take effect:** `--reload` can occasionally keep a stale worker. Stop the server fully and start it again, or switch to a new port.
- **Image questions are slower than text ones:** the vision model is larger, so this is expected.
- **Mic says permission denied:** allow the microphone for the site in your browser settings (it won't work inside some embedded or preview browsers).
