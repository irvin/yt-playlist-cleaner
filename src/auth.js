import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePath(p) {
  return path.resolve(process.cwd(), expandHome(p || ''));
}

function defaultTokenPath() {
  const base = path.join(os.homedir(), '.ytm-dedupe');
  return path.join(base, 'token.json');
}

function getClientSecretsPath() {
  return process.env.YTM_CLIENT_SECRETS_PATH || process.env.GOOGLE_CLIENT_SECRETS_PATH || 'credentials.json';
}

function getTokenPath() {
  return process.env.YTM_TOKEN_PATH || defaultTokenPath();
}

function isValidToken(token) {
  if (!token?.access_token) return false;
  if (!token.expiry_date) return true;
  return token.expiry_date > Date.now() + 60_000;
}

async function loadClientSecrets() {
  const secretPath = resolvePath(getClientSecretsPath());
  const raw = await fsp.readFile(secretPath, 'utf8');
  const parsed = JSON.parse(raw);
  const client = parsed.installed || parsed.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error(`Invalid OAuth client file: missing client_id/client_secret at ${secretPath}`);
  }
  const redirectUri = (client.redirect_uris && client.redirect_uris[0]) || 'http://127.0.0.1:8080/oauth2callback';
  return { clientId: client.client_id, clientSecret: client.client_secret, redirectUri };
}

async function loadToken() {
  const tokenPath = resolvePath(getTokenPath());
  try {
    const raw = await fsp.readFile(tokenPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveToken(token) {
  const tokenPath = resolvePath(getTokenPath());
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify(token, null, 2), 'utf8');
  console.log(`OAuth token saved to ${tokenPath}`);
}

async function refreshOAuthToken(oauth2Client, token) {
  oauth2Client.setCredentials(token);
  if (!token.refresh_token) return null;

  const refreshed = await oauth2Client.refreshAccessToken();
  if (!refreshed?.credentials) return null;

  const merged = { ...token, ...refreshed.credentials };
  await saveToken(merged);
  return merged;
}

async function askForCode(authUrl) {
  console.log('\n尚未取得有效授權，請在瀏覽器開啟下方網址並完成授權：');
  console.log(`\n${authUrl}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question('請貼上瀏覽器回傳的授權碼（authorization code）：');
  await rl.close();
  return code.trim();
}

export async function authorize() {
  const { clientId, clientSecret, redirectUri } = await loadClientSecrets();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  let token = await loadToken();
  if (token) {
    oauth2Client.setCredentials(token);
    if (isValidToken(token)) {
      return oauth2Client;
    }

    try {
      const refreshed = await refreshOAuthToken(oauth2Client, token);
      if (refreshed && isValidToken(refreshed)) {
        oauth2Client.setCredentials(refreshed);
        return oauth2Client;
      }
    } catch (err) {
      console.warn(`OAuth 權杖更新失敗：${err?.message || err}`);
      // 重新走授權流程
      token = null;
    }
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  const code = await askForCode(authUrl);
  if (!code) {
    throw new Error('未提供授權碼，無法繼續。');
  }

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens) throw new Error('無法取得 OAuth tokens');

  await saveToken(tokens);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

export { SCOPES, getTokenPath, resolvePath, getClientSecretsPath };
