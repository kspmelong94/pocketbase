// CK 통합 라이브러리 - 격리 컨텍스트용 단일 진입점
// PocketBase v0.23+ 는 핸들러마다 격리된 컨텍스트를 실행하므로
// 반드시 핸들러 내부에서 require() 로 로드해야 한다.

const lib = Object.assign(
  {},
  require(`${__hooks}/bz-lib.js`),
  require(`${__hooks}/ck-utils.js`),
  require(`${__hooks}/ck-api.js`),
  require(`${__hooks}/ck-matchmaking.js`),
  require(`${__hooks}/ck-verification.js`),
  require(`${__hooks}/ck-settlement.js`),
  require(`${__hooks}/ck-penalties.js`)
);

// URL 쿼리 문자열 파서 (goja 에 URL API 가 없음)
lib.CKParseQuery = function (url) {
  const q = {};
  const s = String(url || "");
  const idx = s.indexOf("?");
  if (idx < 0) return q;
  for (const part of s.slice(idx + 1).split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? "" : part.slice(eq + 1);
    try {
      q[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch (e) {
      q[k] = v;
    }
  }
  return q;
};

module.exports = lib;