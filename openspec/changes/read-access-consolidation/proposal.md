## Why

ADR 0003 把读侧访问判定收进 accessService 后，读接口仍残留两处缺口与一处漂移：

1. **泄露**：`getSiteAnalytics`（siteService.js:678）没有任何访问上下文参数，SQL 返回全部站点（topByHits / recentlyActive / inactiveSites）。`/api/ai/chat` 匿名可达（api.js:213），chat 的「访问最多/最热/排行」意图调用 `getSiteAnalytics(env, { limit })`（aiService.js:1039）——匿名用户可拿到 private / admin_only / unlisted 站点的名字与 URL。其余读接口均已收编 access，唯独此路径在策略 seam 之外。
2. **反向默认值 footgun**：`getSites` 的 `includePrivate` 默认 `true`（`privateUnlocked = includePrivate`），`searchSites` / `listSitesByIds` 默认 `false`——同族函数默认值相反；布尔参数仅存量测试使用（siteService.test.js:244-248），生产调用面已全部传 access。ADR 0003 的决策要点即以 access 收编布尔，此为其收尾。
3. **第三执行点**：`getAllSites` 无 access 参数，home.js:102 以 `access.canList` 在 JS 层过滤——可见性规则的第三个执行点，与 SQL 片段靠对齐纪律维持。

## What Changes

- `getSites` / `searchSites` / `listSitesByIds`：`access` 参数优先（`access || 遗留布尔`），布尔参数与默认值按兼容保留——存量测试一字不动。
- `getAllSites` 增加 `access` 参数，SQL 层过滤可见性：home.js 传页面语义对象（`adminAuthed` + `privateUnlocked: access.browserPrivateUnlocked`，保住 ADR-0003 页面语义），删除 JS `canList` 过滤（子孙分类/标签/排序等呈现过滤保留在 JS）；`exportConfig` 传 admin 上下文（管理员全可见），无无过滤路径。
- `getSiteAnalytics` 增加 `access` 参数，SQL 可见性片段与 `searchSites` 完全一致（API 语义 `privateUnlocked`，token 解锁私人书签——ADR-0002）；aiService 的 chat 排行意图透传访问上下文。
- 测试：存量测试零改动；新增 getSiteAnalytics 三态过滤测试（匿名 / 解锁 / 管理员）与 chat 排行泄露回归测试。
- ADR 0003 追加一条后续备注（access 优先、遗留布尔按兼容保留）。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`——无新需求、无既有需求变更）。

### Modified Capabilities

无（既有 spec 无行为变更：可见性执行点收敛与 chat 排行修复均恢复既有 spec 语义——「匿名访问 SHALL 仍不可见私人书签」，非新需求）。
