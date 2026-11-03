'use strict';
/**
 * テスト用の模擬 Apps Script API サーバー
 *  - PUT  /v1/projects/{id}/content  … push（ファイルを保存。構文エラーは400）
 *  - GET  /v1/projects/{id}/content  … 現在のファイル
 *  - GET  /v1/projects/{id}          … プロジェクト情報
 *  - POST /v1/scripts/{id}:run       … 保存済みファイルを Node の vm で実行し、実測した応答の形で返す
 * エラーの形は 2026-11-03 の実測（USER_ERROR、FUNCTION_NOT_FOUND、403、500 など）に合わせている。
 */
const http = require('http');
const vm = require('vm');

function startMockServer({ scriptId, initialFiles = [], mode = {} } = {}) {
  const state = { files: initialFiles.slice(), runs: [], pushes: 0, sentMail: [] };

  function execute(fnName, params) {
    const sandbox = {
      console: { log() {}, error() {} },
      Session: { getActiveUser: () => ({ getEmail: () => 'tester@example.com' }) },
      MailApp: { sendEmail: (...a) => { state.sentMail.push(a); } },
      UrlFetchApp: { fetch: () => { throw new Error('real fetch in mock'); } },
      ScriptApp: { newTrigger: () => { throw new Error('real trigger in mock'); } },
      Utilities: { newBlob: () => ({ getDataAsString: function () {} }) },
    };
    vm.createContext(sandbox);
    for (const f of state.files.filter((x) => x.type === 'SERVER_JS')) {
      try {
        new vm.Script(f.source, { filename: `${f.name}.gs` }).runInContext(sandbox);
      } catch (e) {
        return { error: { code: 3, message: String(e.message), details: [{ errorType: 'USER_ERROR', errorMessage: String(e.message), scriptStackTraceElements: [] }] } };
      }
    }
    const fn = sandbox[fnName];
    if (typeof fn !== 'function') {
      return { error: { code: 3, message: `Script function not found: ${fnName}`, details: [{ '@type': 'type.googleapis.com/google.apps.script.v1.ExecutionError', errorType: 'FUNCTION_NOT_FOUND', errorMessage: `Script function not found: ${fnName}` }] } };
    }
    try {
      sandbox.__args = params || [];
      const result = vm.runInContext(`${fnName}.apply(null, __args)`, sandbox);
      return { response: { '@type': 'type.googleapis.com/google.apps.script.v1.ExecutionResponse', result: JSON.parse(JSON.stringify(result === undefined ? null : result)) } };
    } catch (e) {
      const name = e && e.name && e.name !== 'Error' ? `${e.name}: ` : (e instanceof Error ? 'Error: ' : '');
      const msg = e instanceof Error ? `${name}${e.message}` : String(e);
      const frames = [];
      for (const line of String((e && e.stack) || '').split('\n')) {
        const m = line.match(/at (?:Object\.)?(\S+) \((.+\.gs):(\d+):\d+\)/) || line.match(/at (.+\.gs):(\d+):\d+/);
        if (m && m.length === 4) frames.push({ function: m[1], lineNumber: Number(m[3]) });
      }
      return { error: { code: 3, message: msg, details: [{ '@type': 'type.googleapis.com/google.apps.script.v1.ExecutionError', errorType: 'USER_ERROR', errorMessage: msg, scriptStackTraceElements: frames }] } };
    }
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return send(401, { error: { code: 401, message: 'Request is missing required authentication credential.', status: 'UNAUTHENTICATED', details: [{ reason: 'CREDENTIALS_MISSING' }] } });
      if (mode.apiDisabled) return send(403, { error: { code: 403, message: 'Apps Script API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });
      const url = req.url.split('?')[0];
      const m = url.match(/^\/v1\/(projects|scripts)\/([^/:]+)(\/content|:run)?$/);
      if (!m) return send(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
      const id = decodeURIComponent(m[2]);
      if (id !== scriptId) return send(500, { error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL', errors: [{ reason: 'backendError' }] } });

      if (m[1] === 'projects' && m[3] === '/content' && req.method === 'PUT') {
        const files = JSON.parse(body).files || [];
        for (const f of files.filter((x) => x.type === 'SERVER_JS')) {
          try {
            new vm.Script(f.source, { filename: `${f.name}.gs` });
          } catch (e) {
            return send(400, { error: { code: 400, message: `Syntax error: ${e.message} file: ${f.name}.gs`, status: 'INVALID_ARGUMENT' } });
          }
        }
        state.files = files;
        state.pushes++;
        return send(200, { scriptId: id, files });
      }
      if (m[1] === 'projects' && m[3] === '/content') return send(200, { scriptId: id, files: state.files });
      if (m[1] === 'projects' && !m[3]) return send(200, { scriptId: id, title: 'mock project' });
      if (m[1] === 'scripts' && m[3] === ':run') {
        const req2 = JSON.parse(body);
        if (/_$/.test(req2.function)) return send(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } });
        state.runs.push(req2);
        if (mode.flaky && mode.flaky-- > 0) return send(503, { error: { code: 503, message: 'unavailable', status: 'UNAVAILABLE' } });
        return send(200, Object.assign({ done: true }, execute(req2.function, req2.parameters)));
      }
      return send(404, { error: { code: 404, message: 'not found' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, state, mode, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startMockServer };
