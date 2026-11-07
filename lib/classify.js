'use strict';
/**
 * scripts.run の応答を終了コードに分類する（設計書9.3：2026-11-03 実測に基づく判定表）
 *
 * | 応答                                                        | 分類 |
 * | 200 + USER_ERROR + "Specified permissions are not sufficient" | 2    | C05
 * | 200 + USER_ERROR（上記以外）                                  | 1    | C01-C04, L01-L02（JS例外の種類はメッセージ先頭）
 * | 200 + FUNCTION_NOT_FOUND / GV_FUNCTION_NOT_FOUND              | 1/2  | H01（ローカルにあれば push 漏れ=2）
 * | 200 + USER_ERROR + "reading from storage. Error code NOT_FOUND" | 2    | H07（GAS側のマニフェストに executionApi がない）
 * | 200 + errorType=SCRIPT_TIMEOUT（実測は code=4）、または code=10 | 1    | C12
 * | 200 + 正常、戻り値に [native code]                             | 1    | C06
 * | 401                                                           | 2    | H04
 * | 403 PERMISSION_DENIED                                          | 1/2  | C10（末尾_の関数）、それ以外はプロジェクト不一致等
 * | 403 SERVICE_DISABLED / accessNotConfigured（Cloud側でAPI無効） | 2    | H06（run・pull・push すべて）
 * | 403「User has not enabled the Apps Script API」                | 2    | H08（ユーザー設定オフ。push のみ失敗）
 * | 404                                                           | 2    |
 * | 500/503/429・通信例外                                          | 3    | H02（IDの誤りでも500）→再試行後も続けば2
 */
const { GvError } = require('./errors');

const PERM_RE = /Specified permissions are not sufficient/i;
const NO_EXECUTION_API_RE = /reading from storage\. Error code NOT_FOUND/i;

function extractRequiredPermissions(message) {
  const m = String(message || '').match(/Required permissions:\s*\(?([^)]*)\)?/i);
  if (!m) return [];
  return m[1].split(/\|\||,|\s+/).map((s) => s.trim()).filter((s) => /^https:\/\//.test(s));
}

/** ランタイムが例外メッセージ末尾に付けたログ（GV_LOGS:<JSON>）を取り出し、メッセージを元に戻す（F11） */
function splitLogs(message) {
  const s = String(message || '');
  const i = s.lastIndexOf('\nGV_LOGS:');
  if (i < 0) return { message: s, logs: null };
  try {
    const logs = JSON.parse(s.slice(i + '\nGV_LOGS:'.length));
    if (Array.isArray(logs)) return { message: s.slice(0, i), logs };
  } catch (e) {
    // 途中で切れているなどで読めない場合はメッセージをそのまま扱う
  }
  return { message: s, logs: null };
}

/** errorMessage 先頭の "TypeError:" などから JS の例外種別を取る */
function jsErrorType(message) {
  const m = String(message || '').match(/^((?:[A-Z][A-Za-z]*)?(?:Error|Exception))\s*:/);
  return m ? m[1] : null;
}

function hasNativeCode(value) {
  try {
    return JSON.stringify(value).includes('[native code]');
  } catch (e) {
    return false;
  }
}

/**
 * @param {object} r { http, data, exception, fn, funcMap }
 *   fn は実際に呼びたい関数名（gasverify_invoke 経由でも中身の関数名）
 * @returns {object} { exitCode, reason, message, next, error?, stack?, requiredPermissions? , result? }
 */
function classify(r) {
  const fn = r.fn || '';
  const funcMap = r.funcMap || {};
  const d = r.data || {};

  // 通信そのものの失敗
  if (r.exception && !r.http) {
    return { exitCode: 3, reason: 'network', message: `通信エラー: ${r.exception}`, next: '時間を置いて再実行してください。続く場合はネットワーク接続を確認してください' };
  }

  if (r.http === 200 || (r.http && r.http < 300)) {
    if (d.error) {
      const x = (d.error.details || [])[0] || {};
      const { message: msg, logs } = splitLogs(x.errorMessage || d.error.message || '');
      const stack = (x.scriptStackTraceElements || []).map((s) => ({ function: s.function, line: s.lineNumber }));
      const base = { error: { type: jsErrorType(msg) || x.errorType || '', category: x.errorType || '', message: msg, code: d.error.code }, stack };
      if (logs) base.logs = logs;

      // C12（2026-11-07実測）：code=4・errorType=SCRIPT_TIMEOUT・スタックなし。公式の code=10 も念のため残す
      if (x.errorType === 'SCRIPT_TIMEOUT' || d.error.code === 10) {
        return Object.assign(base, { exitCode: 1, reason: 'timeout', message: '実行時間の上限（6分）を超えました', next: '処理件数を減らす引数（limit など）を設けるか、処理を分割してください' });
      }
      const gvNotFound = msg.match(/GV_FUNCTION_NOT_FOUND:\s*(\S+)/);
      if (x.errorType === 'FUNCTION_NOT_FOUND' || gvNotFound) {
        const name = gvNotFound ? gvNotFound[1] : fn;
        if (name === 'gasverify_invoke' || /gasverify_/.test(name)) {
          return Object.assign(base, { exitCode: 2, reason: 'runtime_not_pushed', message: 'gasverify のランタイムがGASにありません', next: 'gasverify push（または verify）で反映してください' });
        }
        if (funcMap[name]) {
          return Object.assign(base, { exitCode: 2, reason: 'not_pushed', message: `関数 ${name} はローカルにありますがGAS側にありません`, next: 'gasverify push で最新のコードを反映してください' });
        }
        return Object.assign(base, { exitCode: 1, reason: 'function_not_found', message: `関数 ${name} が見つかりません`, next: '関数名の綴りを確認するか、関数を定義してください' });
      }
      // H07（2026-11-07実測）：GAS側のマニフェストに executionApi（API実行可能）が無いと、関数名によらずこの文言で失敗する。
      // clasp create 直後のプロジェクトのほか、コードを push 済みでも executionApi が無ければ同じ（mywork-dashboard2 で確認）
      if (NO_EXECUTION_API_RE.test(msg)) {
        return Object.assign(base, { exitCode: 2, reason: 'execution_api_missing', message: 'GAS側で関数を実行できません（マニフェストに executionApi の設定が無い）',
          next: '手元の appsscript.json に "executionApi": { "access": "MYSELF" } があることを確かめ、gasverify push（または verify）で反映してください' });
      }
      if (PERM_RE.test(msg)) {
        const req = extractRequiredPermissions(msg);
        return Object.assign(base, { exitCode: 2, reason: 'script_scope_missing', requiredPermissions: req,
          message: 'GAS内で権限（スコープ）が不足しています',
          next: `appsscript.json の oauthScopes に必要なスコープを追加し、gasverify login で再承認してください（人の承認が必要）。候補: ${req.join(' または ') || '(メッセージを参照)'}` });
      }
      return Object.assign(base, { exitCode: 1, reason: 'script_exception', message: msg || 'GAS内で例外が発生しました', next: '診断書の location の箇所を修正してください' });
    }
    const result = d.response ? d.response.result : undefined;
    if (hasNativeCode(result)) {
      return { exitCode: 1, reason: 'non_serializable_return', result, message: '戻り値にApps Script固有のオブジェクト（Blob等）が含まれています', next: '戻り値は文字列・数値・配列・プレーンなオブジェクトだけにしてください' };
    }
    return { exitCode: 0, reason: 'ok', result, message: '成功' };
  }

  const err = d.error || {};
  const reasons = [...(err.details || []).map((x) => x.reason), ...(err.errors || []).map((x) => x.reason)].filter(Boolean);
  const msg = err.message || `HTTP ${r.http}`;
  const httpErr = { error: { type: `HTTP ${r.http}`, category: err.status || '', message: msg, reasons } };

  if (r.http === 401) {
    return Object.assign(httpErr, { exitCode: 2, reason: 'auth_invalid', message: '認証が無効です（期限切れなど）', next: 'gasverify login で再承認してください。個人Gmail（テスト中のアプリ）は7日で失効します' });
  }
  if (r.http === 403) {
    if (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured') || /has not been used|is disabled/i.test(msg)) {
      return Object.assign(httpErr, { exitCode: 2, reason: 'api_disabled', message: 'Cloudプロジェクトで Apps Script API が無効です', next: 'Cloudコンソールの「APIとサービス」→「ライブラリ」で Apps Script API を有効にしてください（人の操作が必要）' });
    }
    if (/has not enabled the Apps Script API|usersettings/i.test(msg)) {
      return Object.assign(httpErr, { exitCode: 2, reason: 'user_api_setting_off', message: 'ユーザー設定で Apps Script API がオフです', next: 'https://script.google.com/home/usersettings で Google Apps Script API をオンにしてください' });
    }
    if (/_$/.test(fn)) {
      return Object.assign(httpErr, { exitCode: 1, reason: 'private_function', message: `${fn} は末尾が _ のため外部から呼べません`, next: '関数名の末尾の _ を外してください' });
    }
    return Object.assign(httpErr, { exitCode: 2, reason: 'permission_denied', message: '呼び出しが拒否されました（403）',
      next: '診断書の account が、このGASのオーナー（編集権限のあるアカウント）か確認してください。仕事用と個人用の取り違えが多い原因です。あわせて、GASを紐付けたCloudプロジェクトと credentials.json の発行元が同じか、テストユーザーに登録済みかを確認してください' });
  }
  if (r.http === 404) {
    return Object.assign(httpErr, { exitCode: 2, reason: 'not_found', message: 'スクリプトまたはデプロイが見つかりません（404）', next: 'スクリプトIDと「API実行可能」デプロイの有無を確認してください。診断書の account にこのGASへのアクセス権がない場合も見つからない扱いになります' });
  }
  if (r.http === 400) {
    return Object.assign(httpErr, { exitCode: 1, reason: 'bad_request', message: `リクエストが不正です: ${msg}`, next: '関数名と引数（JSONで表せる値か）を確認してください' });
  }
  if (r.http === 429 || r.http >= 500) {
    return Object.assign(httpErr, { exitCode: 3, reason: 'server_error', message: `Google側のエラー（${r.http}）`, next: '時間を置いて再実行してください。スクリプトIDの誤りでも500が返ることがあります（実測H02）' });
  }
  return Object.assign(httpErr, { exitCode: 3, reason: 'unexpected', message: `想定外の応答（HTTP ${r.http}）: ${msg}`, next: '診断書の error をそのまま人に報告してください' });
}

/** GvError を分類結果の形にそろえる */
function fromGvError(e) {
  if (e instanceof GvError) return { exitCode: e.exitCode, reason: e.reason, message: e.message, next: e.next };
  return { exitCode: 3, reason: 'internal', message: `gasverify 内部エラー: ${e && e.stack ? e.stack : e}`, next: 'gasverify の不具合の可能性があります。人に報告してください' };
}

module.exports = { classify, fromGvError, jsErrorType, extractRequiredPermissions, splitLogs };
