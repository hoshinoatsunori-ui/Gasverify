/**
 * 確認用GAS（gas_probe.js から呼ばれる）
 * 本番データには一切触れない。実行者のメールアドレスと時刻を返すだけ。
 */
function ping() {
  return {
    ok: true,
    user: Session.getActiveUser().getEmail(),
    at: new Date().toISOString(),
  };
}

/**
 * Q2を実業務のスコープで確かめる用（任意）。
 * Gmailの読み取りスコープが組織で許可されるかを確認する。件名などは返さず、件数だけを返す。
 * appsscript.json の oauthScopes に gmail.readonly を追加してから使う。
 */
function pingGmail() {
  return { ok: true, threads: GmailApp.search('newer_than:1d', 0, 5).length };
}
