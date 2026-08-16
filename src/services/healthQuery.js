// 站点健康谓词单一渲染源（sites 表 dead/ok/unknown 三态 SQL 片段）。
// 拆分前 dead 谓词在 siteService（getSites / searchSites 两处共四份）与 systemHealthService（count 版）
// 各自手写字符串，count 版还漂移出缺少 last_status_code IS NOT NULL 守卫的变体；
// 此后所有消费方统一从本模块渲染，禁止再手写副本（2026-08-16 架构评审候选 5）。
// 三态语义（与拆分前逐字一致）：
// - dead：last_error 非空，或状态码已知且 <200 或 >=400；
// - ok：无错误且状态码为 2xx/3xx；
// - unknown：从未检测（last_checked_at 为空）。

/**
 * 渲染 dead（异常）站点谓词。
 *
 * @param {string} [alias=''] SQL 表别名（查询侧传 's'）；空串渲染裸列名，供无别名的整表 count 场景。
 * @returns {string} SQL 谓词片段（自带外层括号，可直接 AND 拼接）。
 */
export function deadSiteSql(alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  return `(${col('last_error')} IS NOT NULL OR (${col('last_status_code')} IS NOT NULL AND (${col('last_status_code')} < 200 OR ${col('last_status_code')} >= 400)))`;
}

/**
 * 渲染 ok（正常）站点谓词：无错误且状态码为 2xx/3xx。
 *
 * @param {string} [alias=''] SQL 表别名；空串渲染裸列名。
 * @returns {string} SQL 谓词片段（自带外层括号）。
 */
export function okSiteSql(alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  return `(${col('last_error')} IS NULL AND ${col('last_status_code')} >= 200 AND ${col('last_status_code')} < 400)`;
}

/**
 * 渲染 unknown（从未检测）站点谓词。
 *
 * @param {string} [alias=''] SQL 表别名；空串渲染裸列名。
 * @returns {string} SQL 谓词片段。
 */
export function unknownSiteSql(alias = '') {
  return alias ? `${alias}.last_checked_at IS NULL` : 'last_checked_at IS NULL';
}

// ── JS 侧三态谓词（与上方 SQL 渲染器同语义、同注释族）───────────────
// 消费方：搜索评分（siteService）、SSR 徽章（siteCard）、客户端过滤镜像
// （clientScript / adminJs 经生成期内联）。禁止在消费方再手写副本。
// JS 与 SQL 的镜像关系：last_error 非空 ≈ last_error IS NOT NULL；
// last_status_code 空值（null/undefined）必须显式排除——Number(null) 为 0，
// 若不排除会把「已检测但无状态码」误判为 dead（SQL 侧守卫 IS NOT NULL）。

/**
 * JS 版 dead 判定：last_error 非空，或状态码已知且 <200 或 >=400。
 * 与 deadSiteSql 逐字同义；NULL 状态码（gap 态）不判定为 dead。
 */
export function isDeadSite(site) {
  const code = site?.last_status_code;
  return Boolean(site?.last_error)
    || (code !== null && code !== undefined && (Number(code) < 200 || Number(code) >= 400));
}

/**
 * JS 版 ok 判定：无错误且状态码为 2xx/3xx。与 okSiteSql 同义。
 */
export function isOkSite(site) {
  const code = site?.last_status_code;
  return !site?.last_error
    && code !== null && code !== undefined
    && Number(code) >= 200 && Number(code) < 400;
}

/**
 * JS 版 unknown 判定：从未检测（last_checked_at 为空）。与 unknownSiteSql 同义。
 */
export function isUnknownSite(site) {
  return site?.last_checked_at === null || site?.last_checked_at === undefined;
}
