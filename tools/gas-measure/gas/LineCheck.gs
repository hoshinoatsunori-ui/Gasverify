/**
 * Q7：スタックトレースの行番号が「このファイル内の行」と一致するかの確認用
 * 2つ目のファイルに置くことで、行番号がファイルごとか通し番号かを見分ける。
 */

function line_direct() {
  var a = 1;
  throw new Error('line_direct'); // @line line_direct
}

function line_nested() {
  return line_inner_(); // @line line_nested
}

function line_inner_() {
  var b = 2;
  throw new Error('line_inner_'); // @line line_inner_
}
