'use strict';
/**
 * 認証：プロファイルごとに credentials.json（OAuthクライアント）と token.json を ~/.gasverify/<profile>/ に置く
 *
 * 実測で判明した注意（設計書13章）
 *  - @google-cloud/local-auth と googleapis は別バージョンの google-auth-library を使う。
 *    local-auth の戻り値をそのまま使うと認証ヘッダーが付かない（401 CREDENTIALS_MISSING）ため、
 *    googleapis 側の OAuth2 クライアントへ資格情報を移し替える。
 *  - 外部＋テスト中のアプリでは、基本スコープ以外を要求するとテストユーザー登録が必要（403 access_denied）。
 */
const fs = require('fs');
const path = require('path');
const { GvError } = require('./errors');

const SCOPE_PROJECTS = 'https://www.googleapis.com/auth/script.projects';
const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

/** ツールが必要とするスコープ＝push用＋本人確認＋スクリプトのマニフェストのスコープ */
function requiredScopes(manifest) {
  const set = new Set([SCOPE_PROJECTS, SCOPE_EMAIL]);
  for (const s of (manifest && manifest.oauthScopes) || []) set.add(s);
  return [...set].sort();
}

function readClientKeys(cfg) {
  if (!fs.existsSync(cfg.credentialsPath)) {
    throw new GvError(2, 'credentials_missing', `OAuthクライアントの credentials.json がありません: ${cfg.credentialsPath}`,
      'CloudコンソールでデスクトップアプリのOAuthクライアントを作成し、JSONをこの場所に保存してください');
  }
  const keys = JSON.parse(fs.readFileSync(cfg.credentialsPath, 'utf8'));
  const k = keys.installed || keys.web;
  if (!k || !k.client_id) {
    throw new GvError(2, 'credentials_invalid', 'credentials.json の形式が想定と違います',
      'OAuthクライアントの種類を「デスクトップアプリ」にして作り直してください');
  }
  return { keys, k };
}

function readToken(cfg) {
  if (!fs.existsSync(cfg.tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cfg.tokenPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeToken(cfg, data) {
  fs.mkdirSync(path.dirname(cfg.tokenPath), { recursive: true });
  fs.writeFileSync(cfg.tokenPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function grantedScopes(token) {
  return ((token && token.credentials && token.credentials.scope) || '').split(/\s+/).filter(Boolean);
}

function missingScopes(token, needed) {
  const have = new Set(grantedScopes(token));
  return needed.filter((s) => !have.has(s));
}

/** 保存済みトークンからクライアントを作る（自動更新したトークンは保存し直す） */
function getClient(google, cfg) {
  const { k } = readClientKeys(cfg);
  const token = readToken(cfg);
  if (!token || !token.credentials) {
    throw new GvError(2, 'not_logged_in', `プロファイル "${cfg.profileName}" でログインしていません`,
      `gasverify login --profile ${cfg.profileName} を実行してください（ブラウザで承認します）`);
  }
  const client = new google.auth.OAuth2(k.client_id, k.client_secret);
  client.setCredentials(token.credentials);
  client.on('tokens', (t) => {
    const merged = Object.assign({}, token, { credentials: Object.assign({}, token.credentials, t) });
    writeToken(cfg, merged);
  });
  return { client, token };
}

/** ブラウザで承認してトークンを保存し、アカウントのメールアドレスを返す */
async function login(google, cfg, scopes) {
  readClientKeys(cfg);
  const { authenticate } = require('@google-cloud/local-auth');
  let localAuth;
  try {
    localAuth = await authenticate({ keyfilePath: cfg.credentialsPath, scopes });
  } catch (e) {
    throw new GvError(2, 'login_failed', `承認に失敗しました: ${e.message}`,
      '「アクセスをブロック」と表示された場合は、OAuth同意画面のテストユーザーに自分のアドレスを追加してください');
  }
  const { k } = readClientKeys(cfg);
  const client = new google.auth.OAuth2(k.client_id, k.client_secret);
  client.setCredentials(localAuth.credentials);
  let email = '';
  try {
    const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = me.data.email || '';
  } catch (e) {
    email = '(取得失敗)';
  }
  const credentials = Object.assign({}, localAuth.credentials);
  if (!credentials.scope) credentials.scope = scopes.join(' ');
  writeToken(cfg, { email, profile: cfg.profileName, savedAt: new Date().toISOString(), credentials });
  return email;
}

function logout(cfg) {
  if (fs.existsSync(cfg.tokenPath)) {
    fs.unlinkSync(cfg.tokenPath);
    return true;
  }
  return false;
}

module.exports = {
  requiredScopes, readToken, writeToken, getClient, login, logout, missingScopes, grantedScopes, readClientKeys,
  SCOPE_PROJECTS, SCOPE_EMAIL,
};
