/**
 * gasverify ランタイム（push 時に自動で追加される。編集しないこと）
 *
 * 役割
 *  - gasverify_invoke：関数名を受け取り、テストモードで実行して結果を規約の形で返す
 *  - GV：アサーション、ログ、副作用（メール・外部HTTP・トリガー作成）のラッパー
 *    テストモード中は副作用を実行せず sideEffects に記録する（設計書8.3）
 *
 * 本体コードでは MailApp.sendEmail 等を直接呼ばず、GV.sendMail 等を使うこと。
 */
var GV = (function () {
  var state = { testMode: false, assertions: [], sideEffects: [], logs: [], fetchStubs: [] };

  function reset(testMode) {
    state = { testMode: !!testMode, assertions: [], sideEffects: [], logs: [], fetchStubs: [] };
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function plain(v) {
    // 戻り値をJSONにできる形へ（Date は ISO 文字列、undefined は null。実測C07/C08と同じ扱い）
    if (v === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return String(v);
    }
  }

  return {
    _reset: reset,
    _state: function () { return state; },
    _plain: plain,

    /** テストモード中か */
    isTestMode: function () { return state.testMode; },

    /** 値の一致を確認する（JSONとして比較） */
    assertEqual: function (label, expected, actual) {
      var pass = same(plain(expected), plain(actual));
      state.assertions.push({ label: label, pass: pass, expected: plain(expected), actual: plain(actual) });
      return pass;
    },

    /** 条件が真であることを確認する */
    assertTrue: function (label, cond, detail) {
      var pass = !!cond;
      state.assertions.push({ label: label, pass: pass, expected: true, actual: pass, detail: detail === undefined ? null : plain(detail) });
      return pass;
    },

    /** 例外が投げられることを確認する（messageIncludes を指定すると文言も確認） */
    assertThrows: function (label, fn, messageIncludes) {
      var thrown = null;
      try {
        fn();
      } catch (e) {
        thrown = String(e && e.message ? e.message : e);
      }
      var pass = thrown !== null && (!messageIncludes || thrown.indexOf(messageIncludes) >= 0);
      state.assertions.push({ label: label, pass: pass, expected: messageIncludes ? 'throws: ' + messageIncludes : 'throws', actual: thrown === null ? 'no exception' : thrown });
      return pass;
    },

    /** 診断書に載るログ */
    log: function (msg) {
      state.logs.push(typeof msg === 'string' ? msg : JSON.stringify(plain(msg)));
    },

    /** メール送信（テストモードでは送らず記録） */
    sendMail: function (to, subject, body, options) {
      if (state.testMode) {
        state.sideEffects.push({ type: 'mail', to: to, subject: subject, bodyLength: String(body || '').length, dryRun: true });
        return null;
      }
      return MailApp.sendEmail(to, subject, body, options || {}); // gasverify-allow-direct
    },

    /** テストモードでの外部HTTPの応答を決める（url に urlIncludes を含む呼び出しに適用） */
    stubFetch: function (urlIncludes, body, code) {
      state.fetchStubs.push({ urlIncludes: urlIncludes, body: typeof body === 'string' ? body : JSON.stringify(body), code: code || 200 });
    },

    /** 外部HTTP（テストモードでは通信せず、stubFetch の応答か空応答を返す） */
    fetch: function (url, params) {
      if (state.testMode) {
        var stub = null;
        for (var i = 0; i < state.fetchStubs.length; i++) {
          if (String(url).indexOf(state.fetchStubs[i].urlIncludes) >= 0) { stub = state.fetchStubs[i]; break; }
        }
        state.sideEffects.push({ type: 'fetch', url: url, method: (params && params.method) || 'get', stubbed: !!stub, dryRun: true });
        var text = stub ? stub.body : '';
        var code = stub ? stub.code : 200;
        return {
          getContentText: function () { return text; },
          getResponseCode: function () { return code; },
          getHeaders: function () { return {}; },
        };
      }
      return UrlFetchApp.fetch(url, params || {}); // gasverify-allow-direct
    },

    /** 時間主導トリガーの作成（テストモードでは作らず記録）。spec 例：{ everyHours: 1 } / { atHour: 9, everyDays: 1 } */
    createTrigger: function (functionName, spec) {
      spec = spec || {};
      if (state.testMode) {
        state.sideEffects.push({ type: 'trigger', function: functionName, spec: plain(spec), dryRun: true });
        return null;
      }
      var b = ScriptApp.newTrigger(functionName).timeBased(); // gasverify-allow-direct
      if (spec.everyMinutes) b = b.everyMinutes(spec.everyMinutes);
      else if (spec.everyHours) b = b.everyHours(spec.everyHours);
      else if (spec.everyDays) b = b.everyDays(spec.everyDays).atHour(spec.atHour || 0);
      return b.create();
    },
  };
})();

/**
 * gasverify から scripts.run で呼ばれる入口
 * @param {string} name 実行する関数名
 * @param {{testMode:boolean, args:Array}} options
 * 例外は捕まえずにそのまま投げる（スタックの関数名と行番号を gasverify が使うため）
 */
function gasverify_invoke(name, options) {
  options = options || {};
  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  var fn = g[name];
  if (typeof fn !== 'function') {
    throw new Error('GV_FUNCTION_NOT_FOUND: ' + name);
  }
  GV._reset(options.testMode !== false);
  var returned = fn.apply(null, options.args || []);
  var st = GV._state();
  var failed = st.assertions.filter(function (a) { return !a.pass; });
  var ok = failed.length === 0;
  var extra = {};
  if (returned && typeof returned === 'object' && !Array.isArray(returned) && typeof returned.ok === 'boolean') {
    ok = ok && returned.ok;
    if (returned.message) extra.message = returned.message;
  } else if (returned === false) {
    ok = false;
  }
  return {
    name: name,
    ok: ok,
    message: extra.message,
    assertions: st.assertions,
    sideEffects: st.sideEffects,
    logs: st.logs,
    returned: GV._plain(returned),
  };
}

/** doctor 用の疎通確認 */
function gasverify_ping() {
  var user = '';
  try {
    user = Session.getActiveUser().getEmail();
  } catch (e) {
    user = '(userinfo.email スコープなし)';
  }
  return { ok: true, user: user, at: new Date().toISOString(), runtime: '0.1.0' };
}
