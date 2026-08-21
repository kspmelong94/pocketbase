// CK HenrikDev API 래퍼
// 키 풀 관리, 레이트리밋, 캐시, 요청 처리

const { HENRIKDEV_BASE, CK_CACHE_TTL, CK_RATE_LIMIT_PER_MIN, CKLog, CKNow, CKSafeParse, CKParseRiotId } = require(`${__hooks}/ck-utils.js`);

// 키 풀 상태 (메모리 캐시)
let _keyPool = [];
let _keyUsage = new Map(); // keyId -> { count, resetAt }
let _keyPoolLoadedAt = 0;

// 키 풀 로드 (관리자만 접근 가능한 컬렉션)
function CKLoadKeyPool() {
  const now = Date.now();
  if (_keyPool.length > 0 && now - _keyPoolLoadedAt < 300000) return _keyPool; // 5분 캐시
  try {
    const keys = $app.findRecordsByFilter("valorant_keys", "enabled = true", "-last_used_at", 50, 0);
    _keyPool = keys.map((k) => ({
      id: k.id,
      key: k.getString("key"),
      label: k.getString("label"),
      failCount: k.getInt("fail_count") || 0,
    }));
    _keyPoolLoadedAt = now;
    // 사용량 초기화 (새 분 시작 시)
    for (const k of _keyPool) {
      if (!_keyUsage.has(k.id)) _keyUsage.set(k.id, { count: 0, resetAt: now + 60000 });
    }
  } catch (e) {
    _keyPool = [];
  }
  return _keyPool;
}

// 사용 가능한 키 획득 (라운드 로빈 + 레이트리밋 체크)
function CKAcquireKey() {
  const pool = CKLoadKeyPool();
  if (pool.length === 0) return { noKeys: true };
  const now = Date.now();

  // 레이트리밋 체크 및 리셋
  for (const k of pool) {
    const usage = _keyUsage.get(k.id);
    if (usage && now >= usage.resetAt) {
      usage.count = 0;
      usage.resetAt = now + 60000;
    }
  }

  // 사용량 적은 순 정렬
  pool.sort((a, b) => {
    const ua = _keyUsage.get(a.id)?.count || 0;
    const ub = _keyUsage.get(b.id)?.count || 0;
    return ua - ub;
  });

  for (const k of pool) {
    const usage = _keyUsage.get(k.id) || { count: 0, resetAt: now + 60000 };
    if (usage.count < CK_RATE_LIMIT_PER_MIN) {
      usage.count++;
      _keyUsage.set(k.id, usage);
      return { key: k.key, keyId: k.id, label: k.label };
    }
  }

  return { rateLimited: true };
}

// 키 사용 완료 (성공/실패)
function CKReleaseKey(keyId, success) {
  if (!keyId) return;
  try {
    const rec = $app.findRecordById("valorant_keys", keyId);
    if (success) {
      rec.set("fail_count", 0);
      rec.set("last_used_at", CKNow());
    } else {
      rec.set("fail_count", (rec.getInt("fail_count") || 0) + 1);
      if (rec.getInt("fail_count") >= 3) {
        rec.set("enabled", false);
        CKLog("keys", "키 비활성화 (연속 3회 실패)", { keyId });
      }
    }
    $app.save(rec);
    CKRefreshKeyPool();
  } catch (e) {
    /* 무시 */
  }
}

function CKRefreshKeyPool() {
  _keyPool = [];
  _keyPoolLoadedAt = 0;
  CKLoadKeyPool();
}

// 키 사용량 조회 (관리자용)
function CKRateUsage() {
  CKLoadKeyPool();
  const now = Date.now();
  return _keyPool.map((k) => {
    const usage = _keyUsage.get(k.id) || { count: 0, resetAt: now + 60000 };
    return {
      id: k.id,
      label: k.label,
      used: usage.count,
      remaining: Math.max(0, CK_RATE_LIMIT_PER_MIN - usage.count),
      resetAt: new Date(usage.resetAt).toISOString(),
      failCount: k.failCount,
    };
  });
}

function CKHasEnabledKeys() {
  return CKLoadKeyPool().length > 0;
}

// 캐시 조회
function CKCacheGet(key) {
  try {
    const rec = $app.findFirstRecordByFilter("valorant_cache", "key = {:k}", { k: key });
    if (rec) {
      const expiresAt = new Date(rec.getString("expires_at")).getTime();
      if (Date.now() < expiresAt) {
        return CKSafeParse(rec.getString("payload"), null);
      } else {
        // 만료됨 - 삭제
        $app.delete(rec);
      }
    }
  } catch (e) {
    /* 무시 */
  }
  return null;
}

// 캐시 저장
function CKCacheSet(key, payload, ttlMs) {
  try {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const existing = $app.findFirstRecordByFilter("valorant_cache", "key = {:k}", { k: key });
    if (existing) {
      existing.set("payload", JSON.stringify(payload));
      existing.set("expires_at", expiresAt);
      $app.save(existing);
    } else {
      const col = $app.findCollectionByNameOrId("valorant_cache");
      const rec = new Record(col);
      rec.set("key", key);
      rec.set("payload", JSON.stringify(payload));
      rec.set("expires_at", expiresAt);
      $app.save(rec);
    }
  } catch (e) {
    CKLog("cache", "캐시 저장 실패", { key, error: String(e) });
  }
}

// 공통 HTTP 요청 (키 자동 획득/릴리즈 + 캐시)

// 바이트 배열 → UTF-8 문자열 (한글 등 멀티바이트 지원)
function CKBytesToUtf8(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xE0) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
      i += 2;
    } else if (b < 0xF0) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      i += 4;
      const off = cp - 0x10000;
      out += String.fromCharCode(0xD800 + (off >> 10), 0xDC00 + (off & 0x3FF));
    }
  }
  return out;
}

function CKValGet(endpoint, params, options = {}) {
  const cacheKey = options.cacheKey || endpoint + JSON.stringify(params);
  const ttl = options.ttl || CK_CACHE_TTL.matches;

  // 캐시 확인
  if (!options.skipCache) {
    const cached = CKCacheGet(cacheKey);
    if (cached) return { ok: true, data: cached, cached: true };
  }

  const acquired = CKAcquireKey();
  if (acquired.noKeys) return { noKeys: true };
  if (acquired.rateLimited) return { rateLimited: true };

  const { key, keyId } = acquired;
  const url = HENRIKDEV_BASE + endpoint + (key ? "?api_key=" + encodeURIComponent(key) : "");

  try {
    const res = $http.send({
      url,
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "BattleZone-App/1.0 (battlezoneapp.kro.kr)",
      },
      timeout: options.timeout || 15000,
    });

    if (res.statusCode === 429) {
      CKReleaseKey(keyId, false);
      return { rateLimited: true };
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      CKReleaseKey(keyId, false);
      return { noKeys: true, error: "Invalid API key" };
    }
    if (res.statusCode !== 200) {
      CKReleaseKey(keyId, false);
      return { error: "HenrikDev API " + res.statusCode, statusCode: res.statusCode };
    }

    // 빈/비정상 본문 방어 (goja JSON.parse("") 는 SyntaxError 던짐)
    // PB v0.39 $http.send 는 body 를 바이트 배열로 반환하므로 UTF-8 로 디코딩한다.
    let bodyText = "";
    if (res.json !== undefined && res.json !== null) {
      // 일부 버전은 json 필드로 파싱된 본문 제공
      CKReleaseKey(keyId, true);
      const data0 = res.json;
      if (data0 && !options.skipCache) {
        CKCacheSet(cacheKey, data0, ttl);
      }
      return { ok: true, data: data0 };
    } else if (typeof res.body === "string") {
      bodyText = res.body;
    } else if (res.body && typeof res.body.length === "number") {
      bodyText = CKBytesToUtf8(res.body);
    } else if (res.body != null) {
      bodyText = String(res.body);
    }
    if (bodyText.trim() === "") {
      CKReleaseKey(keyId, true);
      CKLog("api", "HenrikDev 빈 본문", { endpoint, statusCode: res.statusCode });
      return { error: "HenrikDev 빈 응답 본문 (HTTP " + res.statusCode + ") - 잠시 후 재시도해 주세요" };
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (parseErr) {
      CKReleaseKey(keyId, true);
      CKLog("api", "HenrikDev 파싱 실패", { endpoint, statusCode: res.statusCode, preview: bodyText.slice(0, 120) });
      return { error: "HenrikDev 응답 파싱 실패 (HTTP " + res.statusCode + "): 본문 시작 [" + bodyText.slice(0, 80) + "]" };
    }
    CKReleaseKey(keyId, true);

    // 캐시 저장
    if (data && !options.skipCache) {
      CKCacheSet(cacheKey, data, ttl);
    }

    return { ok: true, data };
  } catch (e) {
    CKReleaseKey(keyId, false);
    CKLog("api", "요청 실패", { endpoint, error: String(e) });
    return { error: "Network error: " + String(e) };
  }
}

// 계정 조회 (/valorant/v2/account/{name}/{tag})
function CKAccount(riotId) {
  const parsed = CKParseRiotId(riotId);
  if (!parsed) return { noKeys: true, error: "Invalid Riot ID format" };

  const cacheKey = "account:" + parsed.name.toLowerCase() + "#" + parsed.tag.toLowerCase();
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, ...cached, cached: true };

  const result = CKValGet("/valorant/v2/account/" + encodeURIComponent(parsed.name) + "/" + encodeURIComponent(parsed.tag), {}, {
    cacheKey,
    ttl: CK_CACHE_TTL.account,
  });

  if (result.ok && result.data?.data) {
    const acc = result.data.data;
    return {
      ok: true,
      puuid: acc.puuid,
      name: acc.name,
      tag: acc.tag,
      affinity: "ap",
      region: "ap",
    };
  }
  if (result.statusCode === 404) {
    return { ok: false, statusCode: 404, error: "계정을 찾을 수 없습니다. Riot ID(이름#TAG)를 다시 확인해 주세요." };
  }
  return { ok: false, error: result.error, noKeys: result.noKeys, rateLimited: result.rateLimited };
}

// MMR/티어 조회 (/valorant/v2/by-puuid/mmr/{region}/{puuid})
function CKMMR(puuid, affinity) {
  const aff = String(affinity || "ap").toLowerCase();
  const cacheKey = "mmr:" + puuid;
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, tier: cached.tier, tierName: cached.tierName };

  const result = CKValGet("/valorant/v2/by-puuid/mmr/" + encodeURIComponent(aff) + "/" + encodeURIComponent(puuid), {}, {
    cacheKey,
    ttl: CK_CACHE_TTL.mmr,
  });

  if (result.noKeys) return { noKeys: true };
  if (result.rateLimited) return { rateLimited: true };
  // 조회 실패/데이터 없음 = 언랭 취급
  if (!result.ok || !result.data?.data?.current_data) {
    return { ok: true, tier: 0, tierName: "" };
  }
  const cur = result.data.data.current_data || {};
  const tier = Number(cur.currenttier || 0);
  const tierName = String(cur.currenttierpatched || "");
  CKCacheSet(cacheKey, { tier, tierName }, CK_CACHE_TTL.mmr);
  return { ok: true, tier, tierName };
}

// 최근 커스텀 매치 조회 (/valorant/v4/by-puuid/matches/{region}/pc/{puuid}?mode=Custom)
function CKRecentCustomMatchesByPuuid(puuid, affinity) {
  const aff = String(affinity || "ap").toLowerCase();
  const cacheKey = "matches:" + puuid + ":custom";
  const cached = CKCacheGet(cacheKey);
  if (cached && Array.isArray(cached)) return { ok: true, matches: cached };

  const url = "/valorant/v4/by-puuid/matches/" + encodeURIComponent(aff) + "/pc/" + encodeURIComponent(puuid) + "?mode=Custom&size=10";

  const result = CKValGet(url, {}, { skipCache: true }); // 검증용은 캐시 스킵

  if (result.ok && result.data?.data) {
    const list = result.data.data;
    const matches = Array.isArray(list) ? list : [];
    if (matches.length) CKCacheSet(cacheKey, matches, 60000);
    return { ok: true, matches };
  }
  return { ok: false, error: result.error, noKeys: result.noKeys, rateLimited: result.rateLimited };
}

module.exports = {
  CKLoadKeyPool,
  CKAcquireKey,
  CKReleaseKey,
  CKRefreshKeyPool,
  CKRateUsage,
  CKHasEnabledKeys,
  CKCacheGet,
  CKCacheSet,
  CKValGet,
  CKAccount,
  CKMMR,
  CKRecentCustomMatchesByPuuid,
};