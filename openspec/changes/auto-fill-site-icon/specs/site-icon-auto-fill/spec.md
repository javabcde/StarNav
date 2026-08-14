## ADDED Requirements

### Requirement: 点击无图标书签时自动补全图标

站点书签（`sites.logo` 为空）被点击打开时，系统应尝试自动补全图标：后台异步抓取 favicon 并写回 `logo`，不阻塞跳转/打开；已有图标或已被标记为抓取失败的书签不触发抓取。

#### Scenario: 主站点击无图标书签触发补全

- **WHEN** 访客通过 `/go/:id` 打开一个 `logo` 为空且未被标记抓取失败的书签
- **THEN** 跳转正常发生（不因补图标而延迟），后台异步抓取该站 favicon，成功则写回 `sites.logo`

#### Scenario: 已有图标的书签不重复抓取

- **WHEN** 访客点击一个 `logo` 非空的书签
- **THEN** 不触发任何图标抓取或写回

#### Scenario: 插件站内浏览点击无图标书签

- **WHEN** 插件站内浏览中点击一个缓存里无图标（`logo` 为空）的书签
- **THEN** 书签在外部标签正常打开，后台经 `POST /api/site/:id/ensure-favicon` 上报补全，成功后插件本地缓存中该条 `logo` 被更新为返回的 favicon URL

#### Scenario: 补全不阻塞打开

- **WHEN** 插件点击无图标书签后 popup 立即关闭
- **THEN** 补全请求由 background 接管继续完成，打开行为不受影响

### Requirement: 抓取失败永久放弃，仅手动操作重置

favicon 抓取失败（所有源均无结果）的书签应被标记，自动路径不再重试；只有手动操作（admin 批量刷新图标、编辑书签）才清除标记并允许再次自动补全。

#### Scenario: 抓取失败标记后不再自动重试

- **WHEN** 某书签自动补全抓取失败，之后再次被点击打开
- **THEN** 自动路径跳过该书签（不重复抓取），跳转正常发生

#### Scenario: 手动批量刷新重置失败标记

- **WHEN** 管理员对已标记抓取失败的书签执行「批量刷新图标」（`POST /api/config/bulk` action=favicon）
- **THEN** 该站失败标记被清除，此后点击可再次触发自动补全

#### Scenario: 编辑书签重置失败标记

- **WHEN** 管理员编辑一个已标记抓取失败的书签
- **THEN** 该站失败标记被清除，此后点击可再次触发自动补全

### Requirement: 补全接口仅限受信凭据调用

图标补全接口只能由管理员会话或 API token（scope=write）调用，普通访客不可用；接口幂等且只写 `logo` 字段。

#### Scenario: token 可调补全接口

- **WHEN** 插件使用 Bearer token 调用 `POST /api/site/:id/ensure-favicon`
- **THEN** 请求被允许，返回 `{ updated, favicon, reason }`；`updated=true` 时 `favicon` 为新写回的图标 URL

#### Scenario: 未授权访客不可调补全接口

- **WHEN** 无凭据请求 `POST /api/site/:id/ensure-favicon`
- **THEN** 返回 401/403，不执行任何抓取或写回
