#!/usr/bin/env node
/**
 * Review/demo helper script:
 * 1) Verifies that the OAuth token can read Pinterest user + boards
 *    (proves a real integration is connected).
 * 2) Creates a pin only after the user explicitly types a consent phrase
 *    (proves explicit user approval before write actions).
 *
 * Usage:
 *   npm run pinterest:demo
 *   npm run pinterest:demo -- --create-pin
 *
 * Optional environment variables (defaults are used when unset):
 *   PINTEREST_API_BASE=https://api-sandbox.pinterest.com
 *   PINTEREST_DEMO_BOARD_ID=<board_id>
 *   PINTEREST_DEMO_TITLE=Demo Pin from n8n integration
 *   PINTEREST_DEMO_DESCRIPTION=Created after explicit user consent
 *   PINTEREST_DEMO_ALT=Demo image alt text
 *   PINTEREST_DEMO_LINK=https://example.com
 *   PINTEREST_DEMO_IMAGE_URL=https://images.unsplash.com/... (public HTTPS URL)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

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

async function apiCall({ method = 'GET', path, token, baseUrl, body }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回非 JSON: ${res.status} ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = json.message || json.error || text;
    throw new Error(`${method} ${path} 失败: HTTP ${res.status} ${msg}`);
  }
  return json;
}

function parseArgs(argv) {
  return {
    createPin: argv.includes('--create-pin'),
  };
}

async function askForExplicitConsent() {
  const rl = readline.createInterface({ input, output });
  try {
    const expected = 'I CONSENT';
    const answer = await rl.question(
      `\n即将调用 Pinterest Create Pin API。请输入 "${expected}" 继续，否则回车取消： `,
    );
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

function buildPinPayload(boardId) {
  return {
    board_id: boardId,
    title: process.env.PINTEREST_DEMO_TITLE || 'Demo Pin from n8n integration',
    description:
      process.env.PINTEREST_DEMO_DESCRIPTION ||
      'Created after explicit user consent',
    alt_text: process.env.PINTEREST_DEMO_ALT || 'Demo image alt text',
    link: process.env.PINTEREST_DEMO_LINK || 'https://example.com',
    media_source: {
      source_type: 'image_url',
      url:
        process.env.PINTEREST_DEMO_IMAGE_URL ||
        'https://images.unsplash.com/photo-1523419409543-34fd03b2f7f1?auto=format&fit=crop&w=1200&q=80',
    },
  };
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));

  const token = process.env.PINTEREST_ACCESS_TOKEN;
  const baseUrl = (
    process.env.PINTEREST_API_BASE || 'https://api-sandbox.pinterest.com'
  ).replace(/\/$/, '');

  if (!token) {
    console.error('缺少 PINTEREST_ACCESS_TOKEN，请先运行 npm run pinterest:login');
    process.exit(1);
  }

  console.log('== Pinterest Integration Proof ==');
  console.log('API Base:', baseUrl);

  const me = await apiCall({
    path: '/v5/user_account',
    token,
    baseUrl,
  });
  console.log('\n[1/2] OAuth token 有效，已读取当前账号：');
  console.log(JSON.stringify({ username: me.username, account_type: me.account_type }, null, 2));

  const boards = await apiCall({
    path: '/v5/boards?page_size=5',
    token,
    baseUrl,
  });
  const boardList = Array.isArray(boards.items) ? boards.items : [];
  console.log('\n[2/2] 已读取 boards（前 5 条）：');
  console.log(
    JSON.stringify(
      boardList.map((b) => ({ id: b.id, name: b.name, privacy: b.privacy })),
      null,
      2,
    ),
  );

  if (!args.createPin) {
    console.log('\n未传 --create-pin，本次仅做集成验证，不会创建任何 Pin。');
    return;
  }

  const boardId = process.env.PINTEREST_DEMO_BOARD_ID || boardList[0]?.id;
  if (!boardId) {
    console.error(
      '找不到可用 board_id。请设置 PINTEREST_DEMO_BOARD_ID 或确保账号下至少有一个 board。',
    );
    process.exit(1);
  }

  const consented = await askForExplicitConsent();
  if (!consented) {
    console.log('未获得明确同意，已取消创建 Pin。');
    return;
  }

  const payload = buildPinPayload(boardId);
  const pin = await apiCall({
    method: 'POST',
    path: '/v5/pins',
    token,
    baseUrl,
    body: payload,
  });

  console.log('\nCreate Pin 成功：');
  console.log(JSON.stringify({ id: pin.id, title: pin.title, board_id: pin.board_id }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
