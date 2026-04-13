#!/usr/bin/env node
/**
 * Pinterest OAuth2 helper:
 * opens the browser for login/consent, then exchanges the callback code
 * for access_token / refresh_token on a local callback server.
 * Requires Node.js 18+ (built-in fetch).
 *
 * Environment variables (can be placed in the project-root .env;
 * this script auto-loads it when present):
 *   PINTEREST_APP_ID       - Pinterest App ID (maps to OAuth consumer_id)
 *   PINTEREST_APP_SECRET   - App secret key
 * Optional:
 *   PINTEREST_REDIRECT_URI - Must exactly match the app "Redirect link".
 *                            Default: http://localhost:8085/
 *   PINTEREST_OAUTH_URI    - OAuth authorize host.
 *                            Default: https://www.pinterest.com
 *   PINTEREST_API_URI      - API base used for token exchange.
 *                            Default: https://api.pinterest.com
 *                            Sandbox apps can use: https://api-sandbox.pinterest.com
 *   PINTEREST_SCOPES       - Comma-separated scopes. Default includes boards:write
 *                            (required for pin creation).
 *   PINTEREST_REFRESHABLE  - true/false, request a refreshable token.
 *                            Default: true
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'darwin') {
    spawn('open', [url], opts).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { ...opts, shell: true }).unref();
  } else {
    spawn('xdg-open', [url], opts).unref();
  }
}

function portFromRedirectUri(redirectUri) {
  const u = new URL(redirectUri);
  const p = u.port;
  if (p) return Number(p);
  return u.protocol === 'https:' ? 443 : 80;
}

function pathFromRedirectUri(redirectUri) {
  const u = new URL(redirectUri);
  return u.pathname || '/';
}

function buildAuthorizeUrl({
  oauthUri,
  appId,
  redirectUri,
  scopes,
  state,
  refreshable,
}) {
  const base = oauthUri.replace(/\/$/, '');
  const params = new URLSearchParams({
    consumer_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    refreshable: String(refreshable),
    state,
  });
  if (scopes.length) params.set('scope', scopes.join(','));
  return `${base}/oauth/?${params.toString()}`;
}

async function exchangeCode({ apiUri, appId, appSecret, code, redirectUri }) {
  const tokenUrl = `${apiUri.replace(/\/$/, '')}/v5/oauth/token`;
  const basic = Buffer.from(`${appId}:${appSecret}`, 'utf8').toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token 接口非 JSON：HTTP ${res.status}\n${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    const msg = json.message || json.error || text;
    throw new Error(`换 token 失败 HTTP ${res.status}: ${msg}`);
  }
  return json;
}

function htmlPage(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;margin:2rem">${bodyHtml}</body></html>`;
}

async function main() {
  loadDotEnv();

  const appId = process.env.PINTEREST_APP_ID || process.env.PINTEREST_CLIENT_ID;
  const appSecret =
    process.env.PINTEREST_APP_SECRET || process.env.PINTEREST_CLIENT_SECRET;
  if (!appId || !appSecret) {
    console.error(
      '请设置 PINTEREST_APP_ID 与 PINTEREST_APP_SECRET（可写在项目根目录 .env）。\n' +
        '在 https://developers.pinterest.com/apps/ 创建应用并查看凭据。',
    );
    process.exit(1);
  }

  const redirectUri =
    process.env.PINTEREST_REDIRECT_URI || 'http://localhost:8085/';
  const oauthUri = process.env.PINTEREST_OAUTH_URI || 'https://www.pinterest.com';
  const apiUri =
    process.env.PINTEREST_API_URI ||
    process.env.PINTEREST_API_BASE ||
    'https://api.pinterest.com';

  const scopes = (process.env.PINTEREST_SCOPES ||
    'user_accounts:read,boards:read,boards:write,pins:read,pins:write')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const refreshable =
    String(process.env.PINTEREST_REFRESHABLE || 'true').toLowerCase() !==
    'false';

  const state = crypto.randomBytes(24).toString('hex');
  const port = portFromRedirectUri(redirectUri);
  const callbackPath = pathFromRedirectUri(redirectUri);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error('无效的 PINTEREST_REDIRECT_URI 端口');
    process.exit(1);
  }

  const authUrl = buildAuthorizeUrl({
    oauthUri,
    appId,
    redirectUri,
    scopes,
    state,
    refreshable,
  });

  console.log('Redirect URI（须与 Pinterest 应用里配置的完全一致）:');
  console.log(`  ${redirectUri}\n`);
  console.log('正在启动本地回调服务器并打开浏览器…\n');

  const done = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const host = req.headers.host || `127.0.0.1:${port}`;
        const u = new URL(req.url || '/', `http://${host}`);

        if (u.pathname !== callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        const err = u.searchParams.get('error');
        const errDesc = u.searchParams.get('error_description') || '';
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            htmlPage(
              '授权失败',
              `<h1>授权失败</h1><p>${err}</p><p>${errDesc}</p>`,
            ),
          );
          server.close();
          reject(new Error(`OAuth 错误: ${err} ${errDesc}`));
          return;
        }

        const code = u.searchParams.get('code');
        const returnedState = u.searchParams.get('state');
        if (!code || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            htmlPage(
              '无效回调',
              '<h1>缺少 code 或 state 不匹配</h1><p>请从本脚本打开的授权流程完成登录。</p>',
            ),
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          htmlPage(
            '完成',
            '<h1>已收到授权</h1><p>请回到终端查看 access_token。可关闭此页。</p>',
          ),
        );

        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      openBrowser(authUrl);
    });

    server.on('error', reject);
  });

  let code;
  try {
    code = await done;
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }

  console.log('正在用授权码换取 access_token…\n');
  let tokenJson;
  try {
    tokenJson = await exchangeCode({
      apiUri,
      appId,
      appSecret,
      code,
      redirectUri,
    });
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }

  const { access_token, refresh_token, expires_in, scope, token_type } =
    tokenJson;

  console.log('— 成功 —');
  console.log('token_type:', token_type || 'bearer');
  console.log('expires_in:', expires_in);
  console.log('scope:', scope);
  console.log('\nPINTEREST_ACCESS_TOKEN=');
  console.log(access_token);
  if (refresh_token) {
    console.log('\nPINTEREST_REFRESH_TOKEN=');
    console.log(refresh_token);
  }

  const outDir = join(ROOT, 'local-files');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'pinterest-token.json');
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        access_token,
        refresh_token: refresh_token || null,
        scope,
        expires_in,
        saved_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`\n已写入（勿提交 Git）: ${outFile}`);
  console.log('\n将 access_token 复制到 .env 的 PINTEREST_ACCESS_TOKEN= 即可给 n8n / Docker 使用。');
  if (apiUri.includes('sandbox')) {
    console.log('\n当前使用 Sandbox API；n8n 中 PINTEREST_API_BASE 请使用 https://api-sandbox.pinterest.com');
  }
}

main();
