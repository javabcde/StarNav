# WebDAV 传输独立为 lib 适配器：lib/webdav.js

2026-08-16 架构评审（improve-codebase-architecture）候选 2 实施收口。backupService.js（266 行）同住两个域：
WebDAV 传输（~140 行：设置 CRUD、joinWebDavUrl、鉴权头、MKCOL/PUT/DELETE）与备份生命周期（list/prune/
create/restore/scheduled），两者仅 createBackup 一处交汇。该模块还是收编战役（ADR-0007/0008）唯一漏网的
boolString/limitText 本地副本宿主——lib/utils.js 注释宣称「逐字副本收编至此」时它仍未被触及，原因是
零测试模块在战役扫描范围之外。

Status: accepted

## 决策要点

- **新建 `lib/webdav.js`（WebDAV 传输，适配器叶）**：设置 CRUD（`backup.webdav.*` 键域，密码经
  lib/crypto 加密存储）+ 传输（URL 逐段编码、Basic 鉴权、MKCOL 建目录、PUT 上传、探测 PUT+DELETE）。
  配置是适配器自身状态——把设置 CRUD 与传输拆成两模块反而迫使共享 WEBDAV_PREFIX 与设置形状，
  制造第二处耦合，故「设置 + 传输」整体成叶。
- **lib→services 边**：webdav.js 消费 settingsService（D1 设置表）。沿用既有先例——edgeCache→accessService、
  auth.js→unlockSessionService（单一源消费），头注释明示。
- **backupService 收口为生命周期策略**：本地 boolString/limitText 副本删除（lib/utils 单一源恢复）；
  只保留 createBackup 与传输的唯一点交汇（try/catch 容错，上传失败不阻断本地备份）。
- **消费方改指**：api/resources/backups.js 的 webdav 设置/测试端点改从 lib/webdav.js 导入。
- **补测试** `tests/webdav.test.js`：URL 拼接规则（路径段编码/中文/文件名）、鉴权头、上传失败语义、
  生命周期（KV 快照/修剪 30 份/恢复缺失报错/上传失败容错）——此前整个备份域零测试。

## Consequences

- **行为不变**：函数体逐字搬迁；备份路由（/api/backups/*）行为与错误文案零变化。
- **locality**：传输可 mock fetch 直测，生命周期可脱离 fetch 直测；修复战役漂移（utils.js 单一源注释
  与实际一致）。
- **后续**：新增传输适配器（如 S3）时生命周期模块无需改动——适配器接缝已具两适配器形态条件。
