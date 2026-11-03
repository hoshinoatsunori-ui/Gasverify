'use strict';
/**
 * Apps Script API の呼び出し（push と scripts.run）
 * 検証は常に「スクリプトID＋devMode=true」＝最新の保存コードで行う（設計書9.3 H03の解釈）
 */
const { classify } = require('./classify');

function scriptClient(google, auth) {
  const opts = { version: 'v1', auth };
  if (process.env.GASVERIFY_ROOT_URL) opts.rootUrl = process.env.GASVERIFY_ROOT_URL; // テスト用
  return google.script(opts);
}

async function rawCall(fnPromise) {
  try {
    const res = await fnPromise();
    return { http: res.status, data: res.data };
  } catch (e) {
    if (e.response) return { http: e.response.status, data: e.response.data };
    return { http: null, data: null, exception: String(e && e.message) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * scripts.run を実行して分類まで行う。終了コード3は cfg.retry 回まで待って再試行し、
 * それでも続く500はスクリプトIDの誤りの可能性として2に読み替える（実測H02）
 */
async function runFunction(google, auth, cfg, { invoke, fn, params, funcMap }) {
  const script = scriptClient(google, auth);
  const body = { function: invoke, devMode: true };
  if (params) body.parameters = params;
  let last;
  for (let attempt = 0; attempt <= cfg.retry; attempt++) {
    if (attempt > 0) await sleep(Number(process.env.GASVERIFY_RETRY_WAIT_MS || 5000) * attempt);
    const t0 = Date.now();
    const raw = await rawCall(() => script.scripts.run({ scriptId: cfg.scriptId, requestBody: body }));
    const c = classify(Object.assign({}, raw, { fn, funcMap }));
    last = Object.assign(c, { http: raw.http, ms: Date.now() - t0, attempts: attempt + 1, raw: raw.data || raw.exception || null });
    if (c.exitCode !== 3) return last;
  }
  if (last.reason === 'server_error' && last.http === 500) {
    last.exitCode = 2;
    last.reason = 'server_error_persistent';
    last.next = 'Google側の500が続いています。スクリプトIDの誤りでも500になるため、設定の scriptId を確認してください';
  }
  return last;
}

/** push：プロジェクトの内容をローカルのファイル一式で置き換える */
async function pushFiles(google, auth, cfg, files) {
  const script = scriptClient(google, auth);
  const raw = await rawCall(() => script.projects.updateContent({
    scriptId: cfg.scriptId,
    requestBody: { files: files.map((f) => ({ name: f.name, type: f.type, source: f.source })) },
  }));
  return raw;
}

async function getContent(google, auth, cfg) {
  const script = scriptClient(google, auth);
  return rawCall(() => script.projects.getContent({ scriptId: cfg.scriptId }));
}

async function getProject(google, auth, cfg) {
  const script = scriptClient(google, auth);
  return rawCall(() => script.projects.get({ scriptId: cfg.scriptId }));
}

module.exports = { runFunction, pushFiles, getProject, getContent, rawCall };
