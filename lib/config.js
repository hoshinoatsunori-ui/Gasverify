'use strict';
/**
 * 設定ファイル（gasverify.config.json）とプロファイルの読み込み
 *
 * 例:
 * {
 *   "defaultProfile": "personal",
 *   "srcDir": "src",
 *   "testDir": "test",
 *   "profiles": {
 *     "personal": {
 *       "scriptId": "1y5i...",
 *       "allowedScriptIds": ["1y5i..."],
 *       "devUrl": "https://script.google.com/macros/s/AKfy.../dev"   // 任意。Webアプリの画面確認（10A章）用
 *     }
 *   }
 * }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GvError } = require('./errors');

const CONFIG_NAME = 'gasverify.config.json';

function findConfig(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const p = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 認証情報・トークンの保存先（プロファイルごと、リポジトリの外） */
function profileHome(profile) {
  const base = process.env.GASVERIFY_HOME || path.join(os.homedir(), '.gasverify');
  return path.join(base, profile);
}

function loadConfig(opts) {
  const cwd = opts.cwd || process.cwd();
  const file = opts.config ? path.resolve(cwd, opts.config) : findConfig(cwd);
  if (!file) {
    throw new GvError(2, 'config_missing', `${CONFIG_NAME} が見つかりません`,
      'プロジェクトのルートで `gasverify init` を実行して設定ファイルを作成してください');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new GvError(2, 'config_invalid', `${CONFIG_NAME} を読めません: ${e.message}`, 'JSONの書式を確認してください');
  }
  const root = path.dirname(file);
  const profileName = opts.profile || raw.defaultProfile || 'personal';
  const profile = (raw.profiles || {})[profileName];
  if (!profile) {
    throw new GvError(2, 'profile_missing', `プロファイル "${profileName}" が設定にありません`,
      `${CONFIG_NAME} の profiles に "${profileName}" を追加してください`);
  }
  const home = profileHome(profileName);
  return {
    file,
    root,
    profileName,
    scriptId: profile.scriptId,
    allowedScriptIds: profile.allowedScriptIds || [],
    devUrl: profile.devUrl || '',
    srcDir: path.resolve(root, raw.srcDir || 'src'),
    testDir: path.resolve(root, raw.testDir || 'test'),
    retry: Number.isInteger(raw.retry) ? raw.retry : 2,
    sameTestFailLimit: raw.sameTestFailLimit || 5,
    home,
    credentialsPath: profile.credentials ? path.resolve(root, profile.credentials.replace(/^~(?=$|[\\/])/, os.homedir()))
      : path.join(home, 'credentials.json'),
    tokenPath: path.join(home, 'token.json'),
    stateDir: path.join(root, '.gasverify'),
  };
}

/** N01：許可リストにないスクリプトIDは操作しない */
function assertAllowed(cfg) {
  if (!cfg.scriptId) {
    throw new GvError(2, 'script_id_missing', `プロファイル "${cfg.profileName}" に scriptId がありません`,
      'GASの「プロジェクトの設定」→「スクリプトID」を設定ファイルに書いてください');
  }
  if (/^\d+$/.test(cfg.scriptId)) {
    throw new GvError(2, 'script_id_is_project_number', 'scriptId に数字だけのID（Cloudプロジェクト番号）が設定されています',
      'GASの「プロジェクトの設定」にある英数字の「スクリプトID」を設定してください');
  }
  if (!cfg.allowedScriptIds.includes(cfg.scriptId)) {
    throw new GvError(2, 'script_not_allowed', `スクリプトID ${cfg.scriptId} は許可リストにありません`,
      `本番スクリプトでないことを確認したうえで、${CONFIG_NAME} の allowedScriptIds に追加してください（人が判断すること）`);
  }
}

module.exports = { loadConfig, assertAllowed, profileHome, CONFIG_NAME };
