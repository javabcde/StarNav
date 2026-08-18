## ADDED Requirements

### Requirement: 右键收藏弹出分类选择小窗

右键菜单「收藏当前网页到 xxx」点击后，SHALL 不再直接保存，而是弹出小窗让用户选择目标分类后保存。

#### Scenario: 右键网页收藏弹窗

- **WHEN** 用户右键网页并点击「收藏当前网页到 xxx」，且已配置 baseUrl/token
- **THEN** 弹出 ~340×480 小窗（collect-picker），名称预填当前页标题、URL 预填当前页地址
- **AND** 小窗内展示分类缩进树与「保存」按钮

#### Scenario: 右键链接收藏弹窗

- **WHEN** 用户右键链接并点击菜单
- **THEN** 名称预填链接文字、URL 预填链接地址

#### Scenario: 未配置连接信息

- **WHEN** 用户点击菜单但未配置 baseUrl/token
- **THEN** 不弹窗，系统通知提示「请先在插件选项中配置 API 地址和 Token！」

### Requirement: 分类树加载与回退

小窗打开时 SHALL 加载最新分类树；失败时 SHALL 回退本地缓存。

#### Scenario: 拉取成功

- **WHEN** `GET /api/categories/tree` 成功
- **THEN** 渲染该分类树（父分类可展开子分类，缩进两级）

#### Scenario: 拉取失败回退缓存

- **WHEN** 分类树接口失败（网络错误/token 无效）
- **THEN** 回退渲染 `storage.local.categories`（options 刷新缓存写入的那份）

#### Scenario: 无任何分类数据

- **WHEN** 拉取失败且本地缓存为空
- **THEN** 仅显示「未分类」一项兜底

### Requirement: 默认选中分类

小窗打开时 SHALL 默认选中记忆的上次选择；无记忆时 SHALL 用 options 默认分类。

#### Scenario: 有上次记忆

- **WHEN** `storage.local.lastCollectCategory` 存在且仍在该次分类列表中
- **THEN** 默认选中该分类

#### Scenario: 记忆失效或缺失

- **WHEN** 无记忆、记忆分类已被删除、或记忆不在当前分类列表
- **THEN** 默认选中 options 的默认分类；未配置则「未分类」

#### Scenario: 保存后记忆

- **WHEN** 小窗保存成功
- **THEN** 所选分类写入 `lastCollectCategory`，下次打开默认选中

### Requirement: 查重与强制保存

小窗打开时 SHALL 自动查重；重复时 SHALL 提示并提供「仍然保存」。

#### Scenario: URL 已存在

- **WHEN** `GET /api/sites/check-duplicate` 返回重复
- **THEN** 显示重复提示（书签名 + URL）与「仍然保存」按钮
- **AND** 点「保存」不执行；必须点「仍然保存」才提交

#### Scenario: URL 不存在

- **WHEN** 查重结果不重复
- **THEN** 仅显示「保存」按钮，点击直接提交

#### Scenario: 保存竞态重复

- **WHEN** 提交时服务端返回 409（查重后他处已添加）
- **THEN** 系统通知 warning「该网页已在您的站点中收藏过啦！」

### Requirement: 保存后行为

保存提交后 SHALL 按结果处理：成功关窗并通知，失败通知且保持小窗打开可重试。

#### Scenario: 保存成功

- **WHEN** `POST /api/sites` 成功
- **THEN** 小窗 SHALL 自动关闭，系统通知 success「已成功收藏到分类「xxx」！」
- **AND** 所选分类 SHALL 写入 `lastCollectCategory`，`lastCollectCandidate` SHALL 清除

#### Scenario: 保存失败

- **WHEN** 服务端返回错误或网络失败
- **THEN** 系统通知 SHALL 展示对应错误文案（复用现有 showNotification 分级），小窗 SHALL 保持打开可重试
