## Context

- ADR 0003：`getSites` / `searchSites` / `listSitesByIds` / aiService options 增加 `access` 对象；「布尔选项保留默认值兼容存量测试」——本次变更以 access 优先完成收口，遗留布尔按兼容保留（存量测试零改动）。
- 现状调用面：生产路径全部传 `access`（api.js:198,206,257；aiService.js:238）；布尔参数仅 tests/siteService.test.js:244-248 使用（`{ includePrivate: true, privateUnlocked: true }` / `{ adminAuthed: true }`）。
- `getSites` 默认 `includePrivate = true`、`privateUnlocked = includePrivate`；`searchSites` / `listSitesByIds` 默认 `includePrivate = false`——同族反向默认值。
- SQL 可见性片段（三读函数各 1-2 处，共 5 处）：`!adminAuthed` 时 `privateUnlocked ? "COALESCE(s.visibility,'public') IN ('public','private')" : "COALESCE(s.visibility,'public') = 'public' AND COALESCE(c.name, s.catelog) <> ?"`（后随 `PRIVATE_BOOKMARK_CATEGORY` 绑定）；另有 fallback 分支 `s.catelog <> ?`。
- `getAllSites`（565-632）：调用方仅 home.js:65（页面渲染）与 siteService.js:1959（exportConfig 管理员导出）；当前无可见性过滤，home 以 `access.canList` JS 过滤（home.js:102）。
- `getSiteAnalytics`（678-765）：SQL topByHits / recentlyActive / inactiveSites，无 access 参数；唯一调用方 aiService.js:1037-1040（chat「访问最多/最热/排行」意图，/api/ai/chat 匿名可达，api.js:213-216）。
- 页面语义（ADR-0003）：页面路由用 `browserPrivateUnlocked`（token 不授予私人书签）；API 读接口用 `privateUnlocked`（ADR-0002 token 即密码级凭据）。

## Goals / Non-Goals

**Goals:**
- 全部读函数（含 getAllSites、getSiteAnalytics）统一 `access` 参数优先；getAllSites / getSiteAnalytics 无无过滤路径。
- 匿名 chat 排行不再泄露非公开站点；home 页面可见性过滤从 JS 下沉 SQL，执行点收敛。

**Non-Goals:**
- 不改可见性规则本身（SITE_VISIBILITIES / canAccessSite / canListSite 语义不动，SQL 片段逐字复用）。
- 不做候选 5 的「SQL 生成器」——SQL 片段仍为字符串常量，但收敛位置与语义不变。
- 不改 `/submit/suggest-*` 鉴权（ADR 0003 明确留待路由表重构）。
- 不改 go.js 404 隐藏语义。

## Decisions

### D1：`access` 优先，遗留布尔保留（旧测试零改动）
三读函数维持 `resolvedAccess = access || { adminAuthed, privateUnlocked }` 现状语义：生产调用面已全部传 access（api.js:198,206,257；aiService.js:238），布尔参数与默认值原样保留——siteService.test.js:244-248 存量测试一字不动（用户约束：旧测试不改、新老全绿）。`getSiteAnalytics` 的新参数取安全默认：缺省（null）按匿名过滤。
- 替代：删除布尔参数——存量测试需改写，违反「旧测试不动」约束；access 必传无默认——破坏函数可选参数约定。

### D2：`getAllSites` 收编 access，SQL 过滤可见性
签名 `getAllSites(env, { space, space_id, access })`；`access` 存在时应用与 getSites 相同的可见性 SQL 片段。home.js 传页面语义对象 `{ adminAuthed: access.adminAuthed, privateUnlocked: access.browserPrivateUnlocked }`，删除 `sites.filter(access.canList)`（home.js:102）；子孙分类展开/标签过滤/排序等呈现逻辑保留 JS。exportConfig 传 `{ adminAuthed: true }`（管理员导出全量语义不变）。无 `access` 保持现状（无过滤，仅历史形态）；home / exportConfig 两个调用面全部显式传 access。
- 替代：保留 home JS 过滤——可见性第三执行点继续靠对齐纪律。

### D3：`getSiteAnalytics` 收编 access，与 searchSites 同语义
签名 `getSiteAnalytics(env, { limit, access })`；SQL 追加与 searchSites 完全相同的可见性片段（API 语义：`privateUnlocked` 含有效 token，ADR-0002；管理员全可见；匿名仅 public + 非私密分类）。`access` 缺省（null）→ 按匿名过滤（安全默认，接口级杜绝复漏）；两个现有调用方全部显式传：api.js:598 `/api/analytics/sites` 传 `{ adminAuthed: true }`、aiService 排行意图透传 chat 的 access。
- 替代：排行仅 public——与 chat 其他意图（searchSites）行为不一致，解锁用户排行缺私密书签。

## Risks / Trade-offs

- **home 渲染回归**：SQL 过滤与 `canList` JS 谓词必须逐位等价（含 `normalizeVisibility` 的非法值回退 public、私密分类兜底）——以 accessService 既有单测为基准做等价性断言（匿名/解锁/管理员三态 × 各可见性）。
- **exportConfig 缺参**：漏传 access 会让导出退化为匿名（丢 private/admin 数据）——调用面只有一处，改签名后编译器/语法检查 + 导出测试守护。
- **chat 排行语义**：解锁 token 用户在排行中看到私密书签（与搜索一致）——泄露回归测试覆盖匿名路径即可，解锁路径与 searchSites 共用片段天然一致。
