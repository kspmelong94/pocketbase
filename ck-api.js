// CK HenrikDev API 래퍼
// 키 풀 관리, 레이트리밋, 캐시, 요청 처리

const { HENRIKDEV_BASE, CK_CACHE_TTL, CK_RATE_LIMIT_PER_MIN, CKLog, CKNow, CKSafeParse } = require(`${__hooks}/ck-utils.js`);

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
async function CKValGet(endpoint, params, options = {}) {
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
    const res = await $http.send({
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

    const data = JSON.parse(res.body);
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

// 계정 조회 (/valorant/v1/account/{name}/{tag})
async function CKAccount(riotId) {
  const parsed = CKParseRiotId(riotId);
  if (!parsed) return { noKeys: true, error: "Invalid Riot ID format" };

  const cacheKey = "account:" + parsed.name.toLowerCase() + "#" + parsed.tag.toLowerCase();
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, ...cached, cached: true };

  const result = await CKValGet("/valorant/v1/account/" + encodeURIComponent(parsed.name) + "/" + encodeURIComponent(parsed.tag), {}, {
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
  return { ok: false, error: result.error, noKeys: result.noKeys, rateLimited: result.rateLimited };
}

// MMR/티어 조회 (/valorant/v2/mmr/{region}/{puuid})
async function CKMMR(puuid, affinity) {
  const cacheKey = "mmr:" + puuid + ":" + affinity;
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, ...cached, cached: true };

  const region = "ap"; // AP 서버 고정 (한국 계정은 kr 반환 시 조회 실패 가능)
  const result = await CKValGet("/valorant/v2/mmr/" + region + "/" + puuid, {}, {
    cacheKey,
    ttl: CK_CACHE_TTL.mmr,
  });

  if (result.ok && result.data?.data) {
    const mmr = result.data.data;
    const tierNum = CKTierFromMMR(mmr.current?.elo || mmr.elo || 0);
    return {
      ok: true,
      tier: tierNum,
      tierName: CKTierKey(tierNum),
      mmr: mmr.current?.elo || mmr.elo || 0,
    };
  }
  return { ok: false, error: result.error, noKeys: result.noKeys, rateLimited: result.rateLimited };
}

// 최근 커스텀 매치 조회 (/v3/matches/{region}/{name}/{tag}?filter=custom)
async function CKRecentCustomMatches(puuid, affinity, since) {
  // puuid로 계정 정보 역조회 필요 (name#tag 필요) → 랭킹에서 riot_id 사용
  // 여기서는 puuid만 받아서 name#tag를 별도 조회하거나, 랭킹에서 가져와야 함
  // 편의상 호출부에서 riot_id 전달받아 사용
  return { ok: false, error: "Use CKRecentCustomMatchesByRiotId instead" };
}

async function CKRecentCustomMatchesByRiotId(riotId, affinity, since) {
  const parsed = CKParseRiotId(riotId);
  if (!parsed) return { ok: false, error: "Invalid Riot ID" };

  const cacheKey = "matches:" + parsed.name.toLowerCase() + "#" + parsed.tag.toLowerCase() + ":custom";

  const region = "ap"; // AP 서버 고정
  const url = "/v3/matches/" + region + "/" + encodeURIComponent(parsed.name) + "/" + encodeURIComponent(parsed.tag) + "?filter=custom&size=20";
  
  const result = await CKValGet(url, {}, { skipCache: true }); // 검증용은 캐시 스킵 또는 짧은 TTL
  
  if (result.ok && result.data?.data) {
    return { ok: true, matches: result.data.data };
  }
  return { ok: false, error: result.error, noKeys: result.noKeys, rateLimited: result.rateLimited };
}

// 매치 상세 조회 (/v3/matches/{match_id})
async function CKMatchDetail(matchId) {
  const cacheKey = "matchDetail:" + matchId;
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, ...cached, cached: true };

  const result = await CKValGet("/v3/matches/" + matchId, {}, {
    cacheKey,
    ttl: CK_CACHE_TTL.matchDetail,
  });

  if (result.ok && result.data?.data) {
    return { ok: true, match: result.data.data };
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
  CKRecentCustomMatchesByRiotId,
  CKMatchDetail,
};