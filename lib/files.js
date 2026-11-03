'use strict';
/**
 * ローカルファイルの収集、関数対応表（関数名→ファイル:行）、テスト関数の発見、静的検査
 */
const fs = require('fs');
const path = require('path');
const { GvError } = require('./errors');

const RUNTIME_NAME = 'gasverify_runtime';
const RUNTIME_PATH = path.join(__dirname, '..', 'runtime', 'gasverify_runtime.js');

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

function gasTypeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.gs') return 'SERVER_JS';
  if (ext === '.html') return 'HTML';
  return null;
}

/** GAS上のファイル名（サブフォルダは / 区切りで残す。拡張子なし） */
function gasName(baseDir, file) {
  const rel = path.relative(baseDir, file).split(path.sep).join('/');
  return rel.replace(/\.(js|gs|html)$/i, '');
}

function readManifest(cfg) {
  const p = path.join(cfg.srcDir, 'appsscript.json');
  if (!fs.existsSync(p)) {
    throw new GvError(2, 'manifest_missing', `マニフェストがありません: ${p}`,
      'srcDir 直下に appsscript.json を置いてください（GASエディタの「プロジェクトの設定」で表示できます）');
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new GvError(1, 'manifest_invalid', `appsscript.json がJSONとして読めません: ${e.message}`, 'appsscript.json の書式を直してください');
  }
}

/**
 * push するファイル一式。srcDir と testDir（とランタイム）を GAS の files 形式にする
 * 同名ファイルが衝突した場合は準備不足として止める
 */
function collectPushFiles(cfg) {
  const manifest = readManifest(cfg);
  const files = [{ name: 'appsscript', type: 'JSON', source: JSON.stringify(manifest, null, 2), local: path.join(cfg.srcDir, 'appsscript.json') }];
  const seen = new Map([['appsscript', 'appsscript.json']]);
  const add = (baseDir, file) => {
    const type = gasTypeOf(file);
    if (!type) return;
    const name = gasName(baseDir, file);
    const key = `${name}.${type}`;
    if (seen.has(key)) {
      throw new GvError(2, 'duplicate_file', `GAS上で同じ名前になるファイルがあります: ${name}（${seen.get(key)} と ${file}）`,
        'どちらかのファイル名を変えてください');
    }
    seen.set(key, file);
    files.push({ name, type, source: fs.readFileSync(file, 'utf8'), local: file });
  };
  for (const f of listFiles(cfg.srcDir)) add(cfg.srcDir, f);
  if (path.resolve(cfg.testDir) !== path.resolve(cfg.srcDir)) {
    for (const f of listFiles(cfg.testDir)) add(cfg.testDir, f);
  }
  if (seen.has(`${RUNTIME_NAME}.SERVER_JS`)) {
    throw new GvError(2, 'runtime_name_conflict', `${RUNTIME_NAME} はgasverifyの予約名です`, '同名のファイルの名前を変えてください');
  }
  files.push({ name: RUNTIME_NAME, type: 'SERVER_JS', source: fs.readFileSync(RUNTIME_PATH, 'utf8'), local: RUNTIME_PATH });
  return { files, manifest };
}

const FN_RE = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

/** 関数名→{file,line}。スタックにはファイル名が無いため、ローカルの定義から引く（実測Q7：行番号はファイル内の行と一致） */
function buildFuncMap(fileList) {
  const map = {};
  for (const f of fileList) {
    if (f.type !== 'SERVER_JS') continue;
    f.source.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(FN_RE);
      if (m && !map[m[1]]) map[m[1]] = { file: f.local, line: i + 1 };
    });
  }
  return map;
}

/** テスト関数：testDir 内の test_ で始まるトップレベル関数 */
function findTests(cfg, fileList, filter) {
  const testRoot = path.resolve(cfg.testDir) + path.sep;
  const names = [];
  for (const f of fileList) {
    if (f.type !== 'SERVER_JS' || !path.resolve(f.local).startsWith(testRoot)) continue;
    for (const line of f.source.split(/\r?\n/)) {
      const m = line.match(FN_RE);
      if (m && /^test_/.test(m[1])) names.push(m[1]);
    }
  }
  return names.filter((n) => !filter || n.includes(filter));
}

const SIDE_EFFECT_RE = /\b(MailApp\.sendEmail|GmailApp\.sendEmail|GmailApp\.createDraft|UrlFetchApp\.fetch(?:All)?|ScriptApp\.newTrigger)\b/;

/** 静的検査（警告のみ。失敗にはしない） */
function staticChecks(cfg, fileList) {
  const warnings = [];
  const srcRoot = path.resolve(cfg.srcDir) + path.sep;
  for (const f of fileList) {
    if (f.type !== 'SERVER_JS' || f.name === RUNTIME_NAME) continue;
    const lines = f.source.split(/\r?\n/);
    lines.forEach((line, i) => {
      const where = `${path.relative(cfg.root, f.local)}:${i + 1}`;
      if (path.resolve(f.local).startsWith(srcRoot)) {
        const m = line.match(SIDE_EFFECT_RE);
        if (m && !/gasverify-allow-direct/.test(line)) {
          warnings.push({ where, rule: 'direct_side_effect', message: `${m[1]} を直接呼んでいます。テスト時に実行されてしまうため GV.sendMail / GV.fetch / GV.createTrigger を使ってください` });
        }
      }
      const fm = line.match(FN_RE);
      if (fm && /^test_.*_$/.test(fm[1])) {
        warnings.push({ where, rule: 'private_test', message: `${fm[1]} は末尾が _ のため外部から呼べません（実測C10：403）` });
      }
    });
  }
  return warnings;
}

module.exports = { collectPushFiles, buildFuncMap, findTests, staticChecks, readManifest, RUNTIME_NAME, listFiles };
