#!/usr/bin/env node
/**
 * gas_probe.js — GAS自動動作確認（gasverify）導入可否の確認スクリプト
 *
 * 確認できること
 *   Q1 標準Cloudプロジェクトの紐付けとApps Script API有効化が正しくできているか
 *   Q2 自作OAuthクライアントへの承認が組織で許可されるか
 *   （Q3 ユーザー設定のApps Script APIは scripts.run 自体には不要。clasp push で確認する）
 *
 * 事前準備（READMEの手順1〜5を参照）
 *   - 標準Cloudプロジェクトで OAuthクライアント（デスクトップアプリ）を作成し credentials.json を保存
 *   - 確認用GAS（ping関数）をそのプロジェクトに紐付け、「API実行可能」としてデプロイ
 *
 * 使い方
 *   npm install googleapis @google-cloud/local-auth
 *   node gas_probe.js --script <スクリプトID> [--creds ./credentials.json] [--scopes scope1,scope2] [--fn ping]
 *
 * 終了コード
 *   0 = 成功（Q1・Q2ともOK）  1 = GAS内でエラー（Q1・Q2はOK）
 *   2 = 認証・設定の問題（下の「判定」を見る）  3 = 通信など想定外
 */
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const scriptId = arg('script');
const credsPath = path.resolve(arg('creds', './credentials.json'));
const fn = arg('fn', 'ping');
const scopes = arg('scopes', 'https://www.googleapis.com/auth/userinfo.email').split(',');

if (!scriptId) {
  console.error('--script <スクリプトID> を指定してください');
  process.exit(2);
}
if (/^\d+$/.test(scriptId)) {
  console.error('数字だけのIDはCloudプロジェクト番号です。GASの「プロジェクトの設定」にある「スクリプトID」（英数字の長いID）を指定してください');
  process.exit(2);
}

function report(exitCode, verdict, detail) {
  console.log(JSON.stringify({ exitCode, verdict, detail }, null, 2));
  process.exit(exitCode);
}

(async () => {
  let google, authenticate;
  try {
    ({ google } = require('googleapis'));
    ({ authenticate } = require('@google-cloud/local-auth'));
  } catch (e) {
    report(2, '依存パッケージ未導入', 'npm install googleapis @google-cloud/local-auth を実行してください（Node.js導入可否はQ8）');
  }

  // ---- 段階1: OAuth承認（Q2） ----
  let auth;
  try {
    console.error(`[1/2] ブラウザで承認画面を開きます。スコープ: ${scopes.join(', ')}`);
    const localAuth = await authenticate({ keyfilePath: credsPath, scopes });
    // local-auth と googleapis は別バージョンの google-auth-library を使うため、
    // そのまま渡すと認証ヘッダーが付かない（401 CREDENTIALS_MISSING）。
    // googleapis 側の OAuth2 クライアントに資格情報を移し替えて使う。
    const keys = require(credsPath);
    const k = keys.installed || keys.web;
    auth = new google.auth.OAuth2(k.client_id, k.client_secret);
    auth.setCredentials(localAuth.credentials);
  } catch (e) {
    report(2, 'Q2: OAuth承認に失敗',
      'ブラウザに表示された理由を記録してください。管理者によるブロック表示なら、管理者にAPIの制御設定での許可（信頼済み設定）を依頼します。' +
      ` 元のエラー: ${e.message}`);
  }
  console.error('[1/2] 承認OK → Q2は少なくともこのスコープでは許可されています');

  // ---- 段階2: scripts.run（Q1） ----
  const script = google.script({ version: 'v1', auth });
  try {
    console.error(`[2/2] scripts.run: ${fn}（devMode）`);
    const res = await script.scripts.run({
      scriptId,
      requestBody: { function: fn, devMode: true },
    });
    if (res.data.error) {
      // GASまで到達して中で失敗 = 実行経路(Q1/Q2)は通っている
      report(1, 'Q1・Q2はOK（GAS内でエラー）', res.data.error);
    }
    report(0, 'Q1・Q2ともOK：scripts.runで戻り値を取得できました', res.data.response);
  } catch (e) {
    const status = e.response && e.response.status;
    const message = (e.response && e.response.data && JSON.stringify(e.response.data.error)) || e.message;
    if (status === 403) {
      report(2, 'Q1: 拒否（403）',
        '確認する順: (a) Cloudプロジェクトで Apps Script API が有効か (b) GASの紐付け先と credentials.json の発行元が同じプロジェクトか ' +
        '(c) GASのオーナーが自分か。元のエラー: ' + message);
    }
    if (status === 404) {
      report(2, 'Q1: 対象が見つからない（404）',
        'スクリプトIDの誤り、または「API実行可能」としてのデプロイが未作成。元のエラー: ' + message);
    }
    if (status === 401) {
      report(2, '認証エラー（401）', 'トークンの失効など。もう一度実行してください。元のエラー: ' + message);
    }
    report(3, `想定外のエラー（HTTP ${status || 'なし'}）`, message);
  }
})();
