# n8n: Spreadsheet Data -> Publish Pinterest Pins

Use n8n to read `board_id`, `title`, `description`, `alt`, `link`, and `image_url`
from either **Google Sheets** or **local Excel (.xlsx, mounted with Docker)**,
then create Pins via [Pinterest API v5](https://developers.pinterest.com/docs/api/v5/).

## Repository Contents

| Path | Description |
|------|-------------|
| `workflows/pinterest-pins-from-sheet.json` | Main workflow: Google Sheets -> POST `/v5/pins` |
| `workflows/pinterest-pins-from-xlsx-docker.json` | Main workflow: **local** `pins.xlsx` (container path `/data`) -> parse -> POST `/v5/pins` |
| `workflows/pinterest-list-boards.json` | Helper workflow: GET `/v5/boards` to find `board_id` |
| `sheet-data/` | Put `pins.xlsx` here on host, mounted to `/data` in container (see `docker-compose.yml`) |
| `sheet-template/headers.csv` | Header template (import or copy into first row) |
| `docker-compose.yml` | Run n8n locally and inject environment variables |
| `.env.example` | Environment variable template |
| `scripts/pinterest-login.mjs` | Open Pinterest login in browser and exchange OAuth2 token |
| `package.json` | Shortcut commands such as `npm run pinterest:login` |

## Log In to Pinterest and Get a Token (Script)

1. Open [Pinterest Developers](https://developers.pinterest.com/apps/) -> your app -> **Manage**, and add this **Redirect link**:  
   `http://localhost:8085/`  
   (If you change the port, also update `PINTEREST_REDIRECT_URI` in `.env`, and keep it exactly the same.)
2. Fill `PINTEREST_APP_ID` and `PINTEREST_APP_SECRET` in `.env`.  
3. Sandbox apps commonly use `PINTEREST_API_URI=https://api-sandbox.pinterest.com` for token exchange; production uses `https://api.pinterest.com`.  
4. Run in project root:

```bash
npm run pinterest:login
# or: node scripts/pinterest-login.mjs
```

The browser will open Pinterest login/consent. After success, the terminal prints
**PINTEREST_ACCESS_TOKEN** and writes `local-files/pinterest-token.json`
(this directory is ignored by `.gitignore`). Copy the token to `.env` as
`PINTEREST_ACCESS_TOKEN` for n8n / Docker usage.

## Review Demo (Full OAuth + Visible Integration)

To avoid review feedback such as "OAuth flow not fully shown" or
"Pinterest integration not demonstrated", record the following:

1. Show the entry point that triggers authorization in your product
   (or run `npm run pinterest:login` in terminal as a local auth entry).  
2. Capture redirect to Pinterest login/consent page and user approval.  
3. Capture callback success page and terminal token output (masked if needed),
   proving the full **OAuth code -> token** loop.  
4. Run:

```bash
npm run pinterest:demo
```

This script calls `GET /v5/user_account` and `GET /v5/boards` to prove your
product is truly connected to Pinterest (not just showing forms/docs).

5. To demonstrate "write only after explicit consent", run:

```bash
npm run pinterest:demo -- --create-pin
```

The script asks for `I CONSENT` again. It calls `POST /v5/pins` only when the
input matches exactly; otherwise it cancels without writing.

### Recordable Connect Pinterest Page (Recommended)

If you need to strictly show the full flow starting from clicking
"Connect Pinterest", run:

```bash
npm run pinterest:oauth-demo
```

Then open `http://127.0.0.1:<port>` in your browser (the port must match
`PINTEREST_REDIRECT_URI` in `.env`; for example, if it is
`http://localhost:3000/pinterest/callback`, open `http://127.0.0.1:3000`),
and record in this order:

1. Click **Connect Pinterest**.  
2. Redirect to Pinterest official login/consent page, show requested scopes, and authorize.  
3. Return to local demo page showing **Connected Successfully** and `GET /v5/user_account` response.  
4. Click **Load Boards** to show `GET /v5/boards` response (proves real integration).  
5. Click **Load PinterestDoc Rows** to read candidates from `sheet-data/pinterestdoc.xlsx`, then pick one row to auto-fill the form.  
6. Confirm target board and one Pin draft (title/image) in the page for one-time approval.  
7. Click **Publish this pin** and enter `I CONSENT`; only then will it call `POST /v5/pins` (shows per-item user decision, not silent bulk automation).

## Quick Start

### 1. Google Sheets

Use this header row (same as template):

`board_id`, `title`, `description`, `alt`, `link`, `image_url`

- `image_url`: must be a public **HTTPS** URL accessible by Pinterest.
- `board_id`: you can import and run the **list boards** workflow first, then copy from output.

### 2. Pinterest Developer Setup

1. Create an app in [Pinterest Developers](https://developers.pinterest.com/), configure Redirect link, then either use the script above or your own OAuth flow to get an **access token**.  
2. Use `https://api-sandbox.pinterest.com` in Sandbox; switch to `https://api.pinterest.com` plus production token for live usage.

### 3. Local n8n (Docker)

```bash
cp .env.example .env
# Edit .env and fill PINTEREST_ACCESS_TOKEN (optionally adjust PINTEREST_API_BASE)
docker compose up -d
```

Open `http://localhost:5678` in browser and complete the n8n setup wizard.

### 4. Import a Workflow (Choose One)

**A. Google Sheets version** `workflows/pinterest-pins-from-sheet.json`  

1. Open **Pin data** (Google Sheets): connect **Google Sheets OAuth2** (or Service Account), choose spreadsheet and worksheet; if using **By ID**, replace the placeholder with your spreadsheet ID.  
2. **API Pinterest** reads `PINTEREST_ACCESS_TOKEN` and `PINTEREST_API_BASE` from environment by default; if env vars are unavailable, use [Header Auth](https://docs.n8n.io/integrations/builtin/credentials/httprequest/#header-auth).  
3. If you do not need scheduled runs, disconnect **Daily schedule -> Pin data**.

**B. Local XLSX version (Docker)** `workflows/pinterest-pins-from-xlsx-docker.json`  

1. Save Excel as **`sheet-data/pins.xlsx`** on host (same header row as above). `docker-compose.yml` already mounts `./sheet-data` as read-only to **`/data`** and sets `N8N_RESTRICT_FILE_ACCESS_TO=/data` (n8n 2.x disk-read nodes often need an allowlisted directory).  
2. After importing workflow, **Read pins.xlsx** defaults to **`/data/pins.xlsx`**. If filename or subdirectory changes, update **File(s) Selector** accordingly.  
3. **Extract pin rows** uses "Extract From XLSX"; if your target sheet is not the first sheet, set **Options -> Sheet Name**.  
4. If disk-read still fails after n8n upgrades, check [Security environment variables](https://docs.n8n.io/hosting/configuration/environment-variables/security/) and add variables such as `N8N_FILE_ACCESS_WHITELIST` based on your version and official docs.  
5. Host folder permissions: n8n in container usually runs as `node` (commonly UID **1000**). If permission issues occur, run: `sudo chown -R 1000:1000 sheet-data`.

### 5. Import the "Find Board ID" Helper Flow

Import `workflows/pinterest-list-boards.json`, run it, then copy the `id`
from returned JSON into the `board_id` column.

## Column to API Field Mapping

| Column | Pinterest Request Field |
|--------|--------------------------|
| `board_id` | `board_id` |
| `title` | `title` |
| `description` | `description` |
| `alt` | `alt_text` |
| `link` | `link` (field omitted when empty) |
| `image_url` | `media_source.url` (`source_type`: `image_url`) |

If fields do not map as expected at runtime, inspect n8n **Executions** output
from **Pin data**. The JSON keys may differ from header names (for example,
extra spaces). Then update expressions in **API Pinterest** to match actual keys.

## Security

- Do not commit `.env` or exported JSON files containing tokens.  
- This repository already ignores `.env` and `.n8n/` (see `.gitignore`).

## License

Add your preferred license as needed. Workflows and configuration here are
for reference only; always follow current Pinterest / Google documentation.
