## ADDED Requirements

### Requirement: 书签镜像

插件 SHALL 把全量缓存（`browse:cache:v1`）中的非私人收藏投影到浏览器「其他书签/StarNav 收藏」文件夹，使 Chrome 原生地址栏联想可以直接命中 StarNav 收藏而不需要任何关键字前缀。

镜像 SHALL 只包含 http(s) 收藏，SHALL 排除 `visibility` 为 `private`/`admin_only` 或分类为「私人书签」的条目，SHALL 按 URL 去重。

#### Scenario: 缓存就绪后镜像
- **WHEN** 全量缓存写入且 `mirrorBookmarks` 未关闭
- **THEN** 「其他书签」下出现 StarNav 文件夹，包含全部非私人收藏（标题 + URL）

#### Scenario: 私人书签排除
- **WHEN** 缓存中包含 `visibility: 'private'` 或分类为「私人书签」的条目
- **THEN** 该条目不出现在浏览器书签镜像中

### Requirement: 增量对齐

镜像 SHALL 按 URL 增量对齐现有书签：新增缺失项、更新标题变化项、删除缓存中已消失项；镜像文件夹内的文件夹节点（用户自建子文件夹）SHALL NOT 被删除。

#### Scenario: 收藏改名
- **WHEN** StarNav 中某收藏名称变化并触发缓存刷新
- **THEN** 对应浏览器书签标题更新，不产生重复条目

#### Scenario: 收藏删除
- **WHEN** StarNav 中某收藏被删除并触发缓存刷新
- **THEN** 对应浏览器书签被移除

### Requirement: 开关与移除

插件 SHALL 在选项页提供「地址栏直接联想 StarNav 收藏」开关，默认开启。关闭或清空配置时 SHALL 删除插件的镜像文件夹；重新开启 SHALL 立即按当前缓存重建。

#### Scenario: 关闭镜像
- **WHEN** 用户关闭该开关并保存
- **THEN** 「其他书签/StarNav 收藏」文件夹及其内容被删除，之后缓存变化不再创建

### Requirement: 同步防回流

一键同步收集浏览器书签快照时 SHALL 排除镜像文件夹及其子树，避免镜像内容被当作浏览器书签回写 StarNav。

#### Scenario: 执行一键同步
- **WHEN** 镜像文件夹存在且用户点击「一键同步」
- **THEN** 镜像中的书签不进入 `/api/sync/bookmarks` 请求体
