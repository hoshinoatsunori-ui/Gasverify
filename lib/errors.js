'use strict';
/**
 * 終了コード（設計書9.2）
 *   0 成功 / 1 コードの誤り / 2 準備不足 / 3 実行基盤障害
 */
const EXIT = { OK: 0, CODE: 1, SETUP: 2, INFRA: 3 };
const CATEGORY = { 0: 'ok', 1: 'code_error', 2: 'setup_required', 3: 'infrastructure' };

class GvError extends Error {
  /**
   * @param {number} exitCode 1|2|3
   * @param {string} reason   機械向けの理由コード
   * @param {string} message  何が起きたか
   * @param {string} next     次にやること
   */
  constructor(exitCode, reason, message, next) {
    super(message);
    this.exitCode = exitCode;
    this.reason = reason;
    this.next = next;
  }
}

module.exports = { EXIT, CATEGORY, GvError };
