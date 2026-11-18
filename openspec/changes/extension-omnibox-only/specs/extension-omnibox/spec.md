## MODIFIED Requirements

### Requirement: 地址栏关键字入口

插件 SHALL 在 manifest 注册 omnibox 关键字 `qq`；地址栏输入 `qq` + 空格（或 Tab）后 SHALL 进入 StarNav 收藏搜索模式。这是插件提供的唯一地址栏入口；插件 SHALL NOT 把 StarNav 收藏写入浏览器书签。

#### Scenario: 进入搜索模式
- **WHEN** 用户在地址栏输入 `q` 后按空格
- **THEN** 地址栏进入扩展搜索模式，默认建议提示输入关键词

#### Scenario: 未配置插件
- **WHEN** 用户尚未填写 StarNav 地址或 Token 时进入搜索模式
- **THEN** 默认建议提示先在插件选项中配置 StarNav 地址与 Token

#### Scenario: 不写入浏览器书签
- **WHEN** 插件安装、启动或全量缓存更新
- **THEN** 插件不在「书签栏」「其他书签」或任何位置创建 StarNav 收藏镜像

## REMOVED Requirements

### Requirement: 书签镜像
**Reason**: 镜像使站内收藏冒充浏览器书签（只读副本出现在书签管理器），用户否决该交互形态；地址栏搜索改由 `q` 关键字承担。
**Migration**: `onInstalled` / `onStartup` 时按 `chrome.storage.local['bookmark:mirror:folderId']` 记录的 id 一次性删除镜像文件夹并清除该键；无记录时不触碰任何用户书签。

### Requirement: 增量对齐
**Reason**: 镜像写入路径整体删除，不再存在需要对齐的书签副本。

### Requirement: 开关与移除
**Reason**: 功能移除后不再提供「地址栏直接联想 StarNav 收藏」开关。

### Requirement: 同步防回流
**Reason**: 镜像不再存在，一键同步无需排除镜像子树；浏览器书签快照全量进入 `/api/sync/bookmarks`。
