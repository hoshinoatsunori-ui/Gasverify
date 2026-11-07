'use strict';
/**
 * push 前の差分確認（GASエディタで直接直された変更を、push で消さないため）
 *
 * push は GAS 側の内容を手元の内容で「置き換える」。そのため、エディタで直された分は push した瞬間に消える。
 * 対策：push に成功するたびに、送った内容の指紋（ハッシュ）を .gasverify/last-push/<scriptId>.json に保存する。
 * 次の push の前に GAS 側の現在の内容を取り、前回送った内容と比べる。
 *   - 一致 → GAS 側は誰も触っていない。push してよい
 *   - 不一致 → エディタなどで直された。push を止め（終了コード2）、GAS 側の内容を .gasverify/remote/ に保存する
 * 前回の記録がない（初回）ときは、手元の内容と比べ、違えば止める（どちらが新しいか判断できないため）。
 *
 * 比較の正規化（未実測）：Apps Script 側が改行コードや末尾の改行を変える可能性に備え、
 * 改行を \n にそろえ、末尾の空白を除いて比べる。マニフェスト（JSON）はキー順を固定して比べる。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function normalize(file) {
  const src = String(file.source || '');
  if (file.type === 'JSON') {
    try {
      return stableJson(JSON.parse(src));
    } catch (e) {
      // 読めない場合は文字列として比べる
    }
  }
  // \r*\n：Windows で CRLF のまま送った内容がさらに CRLF 化された \r\r\n も 1 つの改行とみなす
  return src.replace(/\r*\n|\r/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}

function fingerprint(file) {
  return crypto.createHash('sha256').update(normalize(file)).digest('hex').slice(0, 16);
}

const key = (f) => `${f.name}.${f.type}`;

function toMap(files) {
  const m = {};
  for (const f of files || []) m[key(f)] = fingerprint(f);
  return m;
}

function snapshotPath(cfg) {
  return path.join(cfg.stateDir, 'last-push', `${cfg.scriptId}.json`);
}

function loadSnapshot(cfg) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(cfg), 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveSnapshot(cfg, files, account) {
  const p = snapshotPath(cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ scriptId: cfg.scriptId, pushedAt: new Date().toISOString(), account, files: toMap(files) }, null, 2));
}

/** GAS 側の内容を .gasverify/remote/<日時>/ に保存する（手元の src は上書きしない） */
function saveRemoteCopy(cfg, remoteFiles, stamp) {
  const dir = path.join(cfg.stateDir, 'remote', stamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of remoteFiles || []) {
    const ext = f.type === 'JSON' ? '.json' : f.type === 'HTML' ? '.html' : '.js';
    const p = path.join(dir, ...`${f.name}${ext}`.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.source || '');
  }
  return dir;
}

/**
 * GAS 側の現在の内容（remoteFiles）が push してよい状態かを判定する
 * @returns {{ ok: boolean, basis: 'last_push'|'local', remoteOnly: string[], modified: string[], removed: string[] }}
 */
function checkDrift(cfg, localFiles, remoteFiles) {
  const snap = loadSnapshot(cfg);
  const remote = toMap(remoteFiles);
  const local = toMap(localFiles);
  // 前回 push したまま GAS 側で変わっていないファイルは、手元で意図して消したものとして止めない
  const remoteOnly = Object.keys(remote).filter((k) => !(k in local) && !(snap && snap.files && snap.files[k] === remote[k]));
  let basis;
  let modified;
  let removed = [];
  if (snap && snap.files) {
    // 前回送った内容から、GAS 側で変わったもの
    basis = 'last_push';
    modified = Object.keys(remote).filter((k) => k in snap.files && snap.files[k] !== remote[k]);
    const added = Object.keys(remote).filter((k) => !(k in snap.files));
    modified = [...new Set([...modified, ...added.filter((k) => !remoteOnly.includes(k))])];
    // GAS 側で削除されたが手元には残っているもの（push すると復活する。削除が意図的かもしれないため確認する）
    removed = Object.keys(snap.files).filter((k) => !(k in remote) && k in local);
  } else {
    // 初回：手元と違う既存ファイルは、どちらが新しいか分からないため止める
    basis = 'local';
    modified = Object.keys(remote).filter((k) => k in local && local[k] !== remote[k]);
  }
  // GAS 側の変更をすでに手元へ取り込んだ（手元と GAS 側が同じ）ものは解決済みとして扱う
  modified = modified.filter((k) => local[k] !== remote[k]);
  const ok = remoteOnly.length === 0 && modified.length === 0 && removed.length === 0;
  return { ok, basis, remoteOnly, modified, removed, lastPushedAt: snap ? snap.pushedAt : null };
}

module.exports = { checkDrift, saveSnapshot, saveRemoteCopy, fingerprint, normalize, loadSnapshot };
