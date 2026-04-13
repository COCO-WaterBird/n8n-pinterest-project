#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const sessions = new Map();
const oauthStates = new Map();

function loadDotEnv() {
  const path = join(ROOT, '.env');
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env */
  }
}

function html(body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pinterest OAuth Demo</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem auto; max-width: 760px; line-height: 1.5; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    button, a.btn { background: #e60023; color: #fff; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary { background: #333; }
    pre { background: #f5f5f5; padding: 10px; border-radius: 8px; overflow: auto; }
    pre.account-json { max-height: 220px; }
    details.account-details { margin-bottom: 12px; }
    details.account-details summary { cursor: pointer; font-weight: 600; }
    select, input[type="text"] { font-size: 16px; padding: 6px 8px; max-width: 100%; box-sizing: border-box; }
    .step-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; align-items: center; }
    .hint { color: #555; font-size: 0.95rem; margin-bottom: 12px; }
    .preview-wrap { border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin: 16px 0; background: #fafafa; }
    .preview-wrap img { max-width: 100%; max-height: 400px; object-fit: contain; border-radius: 8px; display: block; }
    .preview-meta { font-size: 0.9rem; color: #555; margin: 0.35rem 0; }
    .preview-line { margin: 0.5rem 0; font-size: 0.95rem; line-height: 1.45; }
    .preview-line .lbl { display: inline-block; min-width: 8.5rem; font-weight: 600; color: #222; vertical-align: top; }
    .preview-line .val { display: inline-block; max-width: calc(100% - 9rem); word-break: break-word; vertical-align: top; }
    .preview-line code.val { font-size: 0.82rem; background: #eee; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function normalizeRow(row) {
  const out = {
    board_id: String(row.board_id ?? '').trim(),
    title: String(row.title ?? '').trim(),
    description: String(row.description ?? '').trim(),
    alt: String(row.alt ?? '').trim(),
    link: String(row.link ?? '').trim(),
    image_url: String(row.image_url ?? '').trim(),
  };
  return out;
}

function resolvePinterestDocPath() {
  if (process.env.PINTEREST_DOC_PATH) {
    return process.env.PINTEREST_DOC_PATH;
  }
  const inData = join(ROOT, 'sheet-data', 'pinterestdoc.xlsx');
  const inTemplate = join(ROOT, 'sheet-template', 'pinterestdoc.xlsx');
  if (existsSync(inData)) return inData;
  if (existsSync(inTemplate)) return inTemplate;
  return null;
}

function loadPinterestDocRows() {
  const docPath = resolvePinterestDocPath();
  if (!docPath) {
    const tried = [
      join(ROOT, 'sheet-data', 'pinterestdoc.xlsx'),
      join(ROOT, 'sheet-template', 'pinterestdoc.xlsx'),
    ];
    return {
      ok: false,
      message:
        'pinterestdoc.xlsx not found. Copy sheet-template/pinterestdoc.xlsx to sheet-data/pinterestdoc.xlsx, or set PINTEREST_DOC_PATH in .env. Tried: ' +
        tried.join(' | '),
      rows: [],
    };
  }
  const workbook = XLSX.readFile(docPath, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { ok: false, message: 'No worksheet found in pinterestdoc file.', rows: [] };
  }
  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const rows = rawRows
    .map((r) => normalizeRow(r))
    .filter((r) => r.title || r.image_url || r.board_id);
  return {
    ok: true,
    message: `Loaded ${rows.length} row(s) from ${docPath}`,
    rows: rows.map((r, i) => ({ id: String(i + 1), ...r })),
  };
}

async function pinterestApi({ base, token, path, method = 'GET', body, timeoutMs = 60000 }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Pinterest API timed out after ${timeoutMs / 1000}s (network or firewall).`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Pinterest response was not JSON: ${res.status} ${text.slice(0, 260)}`);
  }
  if (!res.ok) {
    const msg = parsed.message || parsed.error || text;
    throw new Error(`Pinterest API error (${res.status}): ${msg}`);
  }
  return parsed;
}

/** Pinterest returns one page per call; follow bookmark until exhausted. */
async function fetchAllBoards({ base, token }) {
  const items = [];
  const seen = new Set();
  let bookmark = '';
  const maxPages = 60;
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({ page_size: '25' });
    if (bookmark) q.set('bookmark', bookmark);
    const data = await pinterestApi({
      base,
      token,
      path: `/v5/boards?${q.toString()}`,
    });
    const chunk = Array.isArray(data.items) ? data.items : [];
    for (const b of chunk) {
      const id = b && b.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        items.push(b);
      }
    }
    const next = data.bookmark;
    if (!next || chunk.length === 0) break;
    bookmark = next;
  }
  return { items, total: items.length };
}

function landingPage() {
  return html(`
    <h1>Pinterest OAuth Review Demo</h1>
    <div class="card">
      <p>Start your recording here: click <b>Connect Pinterest</b> and show the full flow—redirect, consent screen, approval, and successful return to this app.</p>
      <a class="btn" href="/auth/start">Connect Pinterest</a>
    </div>
    <div class="card">
      <p>Compliance notes:</p>
      <ul>
        <li>This page does not collect Pinterest login credentials; sign-in happens on Pinterest’s official OAuth page.</li>
        <li>Write actions (Create Pin) require explicit secondary consent.</li>
      </ul>
    </div>
  `);
}

function connectedPage(account) {
  return html(`
    <h1>Connected Successfully</h1>
    <div class="card">
      <p>Pinterest is connected.</p>
      <details class="account-details" open>
        <summary>Account data from the API (tap to collapse)</summary>
        <pre class="account-json">${escapeHtml(JSON.stringify(account, null, 2))}</pre>
      </details>
      <p class="hint"><b>Next:</b> load your sheet row, review the preview, then publish. If your row includes <code>board_id</code>, you do not need to load boards first.</p>
    </div>
    <div class="card">
      <h3>Publish one pin from PinterestDoc</h3>
      <div class="step-row">
        <button type="button" id="loadDocRows" class="secondary">Load PinterestDoc Rows</button>
        <button type="button" id="loadBoards" class="secondary">Load Boards</button>
      </div>
      <p class="hint">Pick one row, check the preview (including the image), then click <b>Publish this pin</b>. You will be asked to type <code>I CONSENT</code>.</p>
      <label>PinterestDoc row:
        <select id="docRowSelect">
          <option value="">— Load rows first —</option>
        </select>
      </label>
      <div class="preview-wrap" id="rowPreview">
        <p id="previewEmpty" class="hint" style="margin:0">Select a row to preview all sheet columns and the image.</p>
        <div id="previewContent" style="display:none">
          <p class="preview-meta" style="margin-top:0"><strong>Pin preview</strong> (columns from your sheet + image)</p>
          <div class="preview-line"><span class="lbl">board_id</span> <code class="val" id="previewFldBoard">—</code></div>
          <div id="previewBoardHint" class="hint" style="display:none;margin:-0.25rem 0 0.5rem 9rem;font-size:0.85rem">Board menu overrides the sheet value for this publish.</div>
          <div class="preview-line"><span class="lbl">title</span> <span class="val" id="previewFldTitle">—</span></div>
          <div class="preview-line"><span class="lbl">description</span> <span class="val" id="previewFldDesc" style="white-space:pre-wrap">—</span></div>
          <div class="preview-line"><span class="lbl">alt</span> <span class="val" id="previewFldAlt">—</span></div>
          <div class="preview-line"><span class="lbl">link</span> <span class="val" id="previewFldLink">—</span></div>
          <div class="preview-line"><span class="lbl">image_url</span> <code class="val" id="previewFldImageUrl">—</code></div>
          <p class="preview-meta" style="margin-bottom:0.25rem"><strong>Image preview</strong></p>
          <img id="previewImg" alt="" />
          <p id="previewImgError" class="hint" style="display:none;color:#b00020">Image could not load. Check image_url.</p>
        </div>
      </div>
      <button type="button" id="createPin">Publish this pin (explicit consent required)</button>
      <details style="margin-top:16px">
        <summary>Optional: edit fields or choose board from list</summary>
        <p class="hint">If your sheet already has <code>board_id</code>, you can leave the board menu empty.</p>
        <label>Board (from API list):
          <select id="boardSelect">
            <option value="">— Click Load Boards above —</option>
          </select>
        </label>
        <br /><br />
        <label>Title: <input id="pinTitle" type="text" style="width:100%" value="" /></label>
        <br /><br />
        <label>Description: <input id="pinDesc" type="text" style="width:100%" value="" /></label>
        <br /><br />
        <label>Image URL: <input id="pinImage" type="text" style="width:100%" value="" /></label>
        <br /><br />
        <label>Link (optional): <input id="pinLink" type="text" style="width:100%" value="" placeholder="https://..." /></label>
        <br /><br />
        <label>Alt text (optional): <input id="pinAlt" type="text" style="width:100%" value="" /></label>
      </details>
    </div>
    <div class="card">
      <h3>API Output</h3>
      <p id="sessionBanner" class="hint" style="display:none;"></p>
      <pre id="out">No action yet.</pre>
    </div>
    <script>
      (function () {
        const out = document.getElementById('out');
        const banner = document.getElementById('sessionBanner');
        const boardSelect = document.getElementById('boardSelect');
        const docRowSelect = document.getElementById('docRowSelect');
        let docRows = [];

        async function apiFetch(url, options) {
          const res = await fetch(url, {
            credentials: 'include',
            ...options,
          });
          const text = await res.text();
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (e) {
            throw new Error('Response was not JSON (HTTP ' + res.status + '): ' + text.slice(0, 200));
          }
          return { res, data };
        }

        function boardItemsFromResponse(data) {
          if (data.items && Array.isArray(data.items)) return data.items;
          if (data.data && Array.isArray(data.data)) return data.data;
          return [];
        }

        async function checkSession() {
          try {
            const { data } = await apiFetch('/api/session');
            if (!data.ok && banner) {
              banner.style.display = 'block';
              banner.style.color = '#b00020';
              banner.textContent = data.hint || 'Session missing. See API Output after clicking a button.';
            }
          } catch (e) {
            if (banner) {
              banner.style.display = 'block';
              banner.style.color = '#b00020';
              banner.textContent = 'Could not reach /api/session: ' + (e.message || e);
            }
          }
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', checkSession);
        } else {
          checkSession();
        }

        const previewEmpty = document.getElementById('previewEmpty');
        const previewContent = document.getElementById('previewContent');
        const previewFldBoard = document.getElementById('previewFldBoard');
        const previewBoardHint = document.getElementById('previewBoardHint');
        const previewFldTitle = document.getElementById('previewFldTitle');
        const previewFldDesc = document.getElementById('previewFldDesc');
        const previewFldAlt = document.getElementById('previewFldAlt');
        const previewFldLink = document.getElementById('previewFldLink');
        const previewFldImageUrl = document.getElementById('previewFldImageUrl');
        const previewImg = document.getElementById('previewImg');
        const previewImgError = document.getElementById('previewImgError');
        const pinTitle = document.getElementById('pinTitle');
        const pinDesc = document.getElementById('pinDesc');
        const pinImage = document.getElementById('pinImage');
        const pinLink = document.getElementById('pinLink');
        const pinAlt = document.getElementById('pinAlt');

        function scrollToApiOutput() {
          try {
            out.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (e) { /* ignore */ }
        }

        function effectiveBoardId() {
          const fromMenu = (boardSelect.value && boardSelect.value.trim()) || '';
          if (fromMenu) return fromMenu;
          const idx = Number(docRowSelect.value);
          if (!Number.isFinite(idx) || !docRows[idx]) return '';
          return String(docRows[idx].board_id || '').trim();
        }

        function updatePreview() {
          const idx = docRowSelect.value === '' ? NaN : Number(docRowSelect.value);
          const hasRow = Number.isFinite(idx) && docRows[idx];
          if (!hasRow && !pinTitle.value.trim() && !pinImage.value.trim()) {
            previewEmpty.style.display = '';
            previewContent.style.display = 'none';
            return;
          }
          previewEmpty.style.display = 'none';
          previewContent.style.display = '';

          const bid = effectiveBoardId();
          previewFldBoard.textContent = bid || '—';

          const sheetBid = hasRow ? String(docRows[idx].board_id || '').trim() : '';
          const menuBid = (boardSelect.value && boardSelect.value.trim()) || '';
          if (previewBoardHint) {
            previewBoardHint.style.display =
              hasRow && sheetBid && menuBid && menuBid !== sheetBid ? 'block' : 'none';
          }

          previewFldTitle.textContent = pinTitle.value.trim() || '—';
          previewFldDesc.textContent = pinDesc.value.trim() || '—';
          previewFldAlt.textContent = pinAlt.value.trim() || '—';

          const linkVal = pinLink.value.trim();
          previewFldLink.textContent = '';
          if (linkVal) {
            const a = document.createElement('a');
            a.href = linkVal;
            a.textContent = linkVal;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            previewFldLink.appendChild(a);
          } else {
            previewFldLink.textContent = '—';
          }

          const imgUrl = pinImage.value.trim();
          previewFldImageUrl.textContent = imgUrl || '—';
          previewImg.alt = pinAlt.value.trim() || pinTitle.value.trim() || 'Pin image';
          previewImgError.style.display = 'none';
          if (imgUrl) {
            previewImg.style.display = '';
            previewImg.onload = function () {
              previewImgError.style.display = 'none';
            };
            previewImg.onerror = function () {
              previewImgError.style.display = '';
            };
            if (previewImg.src !== imgUrl) {
              previewImg.src = imgUrl;
            }
          } else {
            previewImg.style.display = 'none';
            previewImg.removeAttribute('src');
          }
        }

        [pinTitle, pinDesc, pinImage, pinLink, pinAlt].forEach(function (el) {
          el.addEventListener('input', updatePreview);
        });
        boardSelect.addEventListener('change', updatePreview);

        document.getElementById('loadDocRows').onclick = async function () {
          try {
            out.textContent = 'Loading pinterestdoc rows...';
            scrollToApiOutput();
            const { data } = await apiFetch('/api/pinterestdoc-rows');
            docRows = Array.isArray(data.rows) ? data.rows : [];
            docRowSelect.innerHTML = '<option value="">— Select one row —</option>';
            docRows.forEach(function (row, idx) {
              const opt = document.createElement('option');
              opt.value = String(idx);
              const title = row.title || '(no title)';
              opt.textContent = '#' + row.id + ' ' + title;
              docRowSelect.appendChild(opt);
            });
            out.textContent = JSON.stringify(data, null, 2);
            scrollToApiOutput();
          } catch (e) {
            out.textContent = 'Error: ' + (e.message || e);
            scrollToApiOutput();
          }
        };

        docRowSelect.onchange = function () {
          const idx = Number(docRowSelect.value);
          if (!Number.isFinite(idx) || !docRows[idx]) {
            updatePreview();
            return;
          }
          const row = docRows[idx];
          pinTitle.value = row.title || '';
          pinDesc.value = row.description || '';
          pinImage.value = row.image_url || '';
          pinLink.value = row.link || '';
          pinAlt.value = row.alt || '';
          if (row.board_id) {
            boardSelect.value = row.board_id;
          }
          out.textContent = 'Row #' + row.id + ' loaded — review preview, then Publish.';
          updatePreview();
        };

        document.getElementById('loadBoards').onclick = async function () {
          try {
            out.textContent = 'Loading boards from Pinterest…';
            scrollToApiOutput();
            const { res, data } = await apiFetch('/api/boards');
            const items = boardItemsFromResponse(data);
            if (items.length) {
              boardSelect.innerHTML = '<option value="">— Select a board —</option>';
              items.forEach(function (b) {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.name ? (b.name + ' (' + b.id + ')') : b.id;
                boardSelect.appendChild(opt);
              });
            } else {
              boardSelect.innerHTML =
                '<option value="">— No boards in response (see API Output) —</option>';
            }
            out.textContent = JSON.stringify({ httpStatus: res.status, body: data }, null, 2);
            try {
              updatePreview();
            } catch (prevErr) {
              console.error(prevErr);
            }
            scrollToApiOutput();
          } catch (e) {
            out.textContent = 'Error: ' + (e.message || e);
            scrollToApiOutput();
          }
        };

        document.getElementById('createPin').onclick = async function () {
          try {
            const boardId = effectiveBoardId();
            const title = pinTitle.value.trim();
            const description = pinDesc.value.trim();
            const imageUrl = pinImage.value.trim();
            const link = pinLink.value.trim();
            const alt_text = pinAlt.value.trim();
            if (!boardId || !title || !imageUrl) {
              out.textContent = 'Need board_id (from sheet or board menu), title, and image URL. Check preview.';
              scrollToApiOutput();
              return;
            }
            const raw = prompt('Type I CONSENT to publish this pin:');
            if (raw === null) {
              out.textContent = 'Cancelled (dialog closed).';
              scrollToApiOutput();
              return;
            }
            const answer = raw.trim().replace(/\u00A0/g, ' ');
            if (answer !== 'I CONSENT') {
              out.textContent =
                'Consent not accepted. Type exactly: I CONSENT (capital I, rest uppercase). You typed: ' +
                JSON.stringify(raw);
              scrollToApiOutput();
              return;
            }
            out.textContent = 'Publishing… (calling Pinterest API, may take up to 60s)';
            scrollToApiOutput();
            const { res, data } = await apiFetch('/api/create-pin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                consent: answer,
                board_id: boardId,
                title: title,
                description: description,
                image_url: imageUrl,
                link: link,
                alt_text: alt_text
              })
            });
            out.textContent = JSON.stringify({ httpStatus: res.status, body: data }, null, 2);
            scrollToApiOutput();
          } catch (e) {
            out.textContent = 'Error: ' + (e.message || e);
            scrollToApiOutput();
          }
        };
      })();
    <\/script>
  `);
}

function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function main() {
  loadDotEnv();

  const appId = process.env.PINTEREST_APP_ID || process.env.PINTEREST_CLIENT_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET || process.env.PINTEREST_CLIENT_SECRET;
  const redirectUri = process.env.PINTEREST_REDIRECT_URI || 'http://localhost:8085/auth/callback';
  const callbackPath = new URL(redirectUri).pathname || '/';
  const oauthBase = (process.env.PINTEREST_OAUTH_URI || 'https://www.pinterest.com').replace(/\/$/, '');
  const apiBase = (
    process.env.PINTEREST_API_URI ||
    process.env.PINTEREST_API_BASE ||
    'https://api.pinterest.com'
  ).replace(/\/$/, '');
  const scopes = (process.env.PINTEREST_SCOPES ||
    'user_accounts:read,boards:read,boards:write,pins:read,pins:write')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');

  if (!appId || !appSecret) {
    console.error('Set PINTEREST_APP_ID and PINTEREST_APP_SECRET in .env');
    process.exit(1);
  }

  const port = Number(new URL(redirectUri).port || 80);
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `127.0.0.1:${port}`;
      const u = new URL(req.url || '/', `http://${host}`);

      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(landingPage());
        return;
      }

      if (req.method === 'GET' && u.pathname === '/auth/start') {
        const state = crypto.randomBytes(20).toString('hex');
        oauthStates.set(state, Date.now());
        const auth = new URL(`${oauthBase}/oauth/`);
        auth.searchParams.set('consumer_id', appId);
        auth.searchParams.set('redirect_uri', redirectUri);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('refreshable', 'true');
        auth.searchParams.set('scope', scopes);
        auth.searchParams.set('state', state);
        res.writeHead(302, { Location: auth.toString() });
        res.end();
        return;
      }

      if (req.method === 'GET' && u.pathname === callbackPath) {
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html(`<h1>OAuth failed</h1><p>${escapeHtml(err)}</p>`));
          return;
        }
        if (!code || !state || !oauthStates.has(state)) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html('<h1>Invalid callback</h1><p>Missing code/state.</p>'));
          return;
        }
        oauthStates.delete(state);

        const basic = Buffer.from(`${appId}:${appSecret}`, 'utf8').toString('base64');
        const tokenRes = await fetch(`${apiBase}/v5/oauth/token`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(tokenJson.message || 'token exchange failed');
        }

        const account = await pinterestApi({
          base: apiBase,
          token: tokenJson.access_token,
          path: '/v5/user_account',
        });
        const sid = crypto.randomBytes(24).toString('hex');
        sessions.set(sid, { token: tokenJson.access_token, apiBase, account });

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`,
        });
        res.end(connectedPage(account));
        return;
      }

      if (req.method === 'GET' && u.pathname === '/api/session') {
        const session = getSession(req);
        return json(res, 200, {
          ok: Boolean(session),
          hint: session
            ? null
            : 'No session cookie. Open this app using the SAME host as PINTEREST_REDIRECT_URI (e.g. if redirect is http://localhost:3000/... do not use http://127.0.0.1:3000).',
        });
      }

      if (req.method === 'GET' && u.pathname === '/api/boards') {
        const session = getSession(req);
        if (!session) return json(res, 401, { error: 'Not connected' });
        const { items, total } = await fetchAllBoards({
          base: session.apiBase,
          token: session.token,
        });
        return json(res, 200, {
          items,
          bookmark: null,
          total_boards_fetched: total,
        });
      }

      if (req.method === 'GET' && u.pathname === '/api/pinterestdoc-rows') {
        const session = getSession(req);
        if (!session) return json(res, 401, { error: 'Not connected' });
        const result = loadPinterestDocRows();
        return json(res, 200, result);
      }

      if (req.method === 'POST' && u.pathname === '/api/create-pin') {
        const session = getSession(req);
        if (!session) return json(res, 401, { error: 'Not connected' });

        let bodyText = '';
        req.on('data', (chunk) => {
          bodyText += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const body = bodyText ? JSON.parse(bodyText) : {};
            const consent = String(body.consent ?? '')
              .trim()
              .replace(/\u00A0/g, ' ');
            if (consent !== 'I CONSENT') {
              return json(res, 400, {
                error: 'Explicit consent required',
                message: 'Type I CONSENT exactly (no extra spaces).',
              });
            }
            const boardId = String(body.board_id || '').trim();
            const title = String(body.title || '').trim();
            const description = String(body.description || '').trim();
            const imageUrl = String(body.image_url || '').trim();
            const linkOpt = String(body.link || '').trim();
            const altOpt = String(body.alt_text || '').trim();
            if (!boardId) {
              return json(res, 400, { error: 'board_id is required (user-selected)' });
            }
            if (!title || !imageUrl) {
              return json(res, 400, { error: 'title and image_url are required' });
            }
            const pinBody = {
              board_id: boardId,
              title,
              description:
                description || 'Created after explicit user consent in demo UI',
              alt_text:
                altOpt ||
                process.env.PINTEREST_DEMO_ALT ||
                'Pin image',
              media_source: {
                source_type: 'image_url',
                url: imageUrl,
              },
            };
            const defaultLink = String(process.env.PINTEREST_DEMO_LINK || '').trim();
            if (linkOpt) {
              pinBody.link = linkOpt;
            } else if (defaultLink) {
              pinBody.link = defaultLink;
            }
            const pin = await pinterestApi({
              base: session.apiBase,
              token: session.token,
              path: '/v5/pins',
              method: 'POST',
              body: pinBody,
            });
            return json(res, 200, {
              ok: true,
              message: 'Pin created after explicit consent',
              pin: { id: pin.id, title: pin.title, board_id: pin.board_id },
            });
          } catch (e) {
            return json(res, 500, { error: e.message || String(e) });
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (e) {
      json(res, 500, { error: e.message || String(e) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`OAuth demo server running at http://127.0.0.1:${port}`);
    console.log(`Redirect URI configured as: ${redirectUri}`);
    console.log(`Callback path in use: ${callbackPath}`);
    console.log('Use this page for recording: click "Connect Pinterest" and show full OAuth flow.');
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
