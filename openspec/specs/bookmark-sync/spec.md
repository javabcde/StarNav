# Bookmark Sync

浏览器书签对齐同步：以浏览器收藏为事实源，把同步来源书签完全对齐（增/改/删），手动书签永不参与。双入口（扩展一键 + HTML 文件上传）共用同一后端管线，空快照保护拒绝误删。

## Requirements

### Requirement: 来源标记

站点 SHALL 有同步来源标记：`sync_source` 字段，取值 `manual` 或 `browser`，默认 `manual`。手动书签 SHALL 永不参与同步对齐；同步书签 SHALL 参与。扩展单条收藏、现有 JSON/CSV 导入与备份恢复 SHALL 产生手动书签；仅一键同步管线 SHALL 产生同步书签。同步书签 SHALL 记录浏览器侧书签 ID（`browser_bookmark_id`，扩展路径）。

#### Scenario: 存量站点默认手动
- **WHEN** schema 迁移后查询既有站点
- **THEN** 全部为 `sync_source='manual'`，行为与迁移前一致

#### Scenario: 扩展单条收藏为手动
- **WHEN** 用户用扩展「收藏当前页」保存站点
- **THEN** 该站点 `sync_source='manual'`，不参与同步对齐

#### Scenario: 解除同步
- **WHEN** 用户对同步书签执行「解除同步」
- **THEN** 该站点 `sync_source` 置 `manual`、`browser_bookmark_id` 被清除，此后不参与对齐

### Requirement: 全量对齐语义

同步 SHALL 以浏览器收藏快照为事实源，把同步书签完全对齐：快照中有而 StarNav 无的 SHALL 新增；两者都有的 SHALL 更新（仅 name、url、分类三个字段）；快照中无的同步书签 SHALL 删除。手动书签 SHALL 不被新增所重复、不被更新、不被删除。

#### Scenario: 浏览器新增书签被导入
- **WHEN** 浏览器收藏含 StarNav 中没有的新书签（URL 不撞任何站点），执行同步
- **THEN** 该书签作为同步书签插入，分类按文件夹映射

#### Scenario: 浏览器改名传播
- **WHEN** 浏览器书签标题从「旧名」改为「新名」，执行同步
- **THEN** 对应同步书签 name 更新为「新名」，其余字段不变

#### Scenario: 浏览器删除书签同步删除
- **WHEN** 浏览器删除了某书签，其对应同步书签仍在 StarNav，执行同步
- **THEN** 该同步书签被删除，且删除前写入操作日志

#### Scenario: 手动书签不被触碰
- **WHEN** 浏览器快照不包含某手动书签，执行同步
- **THEN** 该手动书签保留，不更新、不删除

#### Scenario: 手动书签挡住同名浏览器书签
- **WHEN** 浏览器书签 URL 与手动书签 url_key 相同，执行同步
- **THEN** 不新增、不更新该手动书签；该浏览器书签计入「跳过」

### Requirement: 配对与 URL 更新

配对 SHALL 以 url_key（规范化 URL）为主、`browser_bookmark_id` 为辅助：扩展路径下书签 ID 命中 SHALL 原地更新（URL 变化时重算 url_key）；HTML 文件路径无 ID，URL 被改 SHALL 表现为删旧插新。多浏览器按 URL 合并，后同步的浏览器 SHALL 覆盖同 URL 项（last-write-wins）。

#### Scenario: 扩展路径 URL 原地更新
- **WHEN** 浏览器书签 URL 从 `https://a.com/x` 改为 `https://a.com/y`（ID 不变），执行扩展同步
- **THEN** 对应同步书签 url 与 url_key 更新为 `https://a.com/y` 对应值，站点 ID 与访问次数保留

#### Scenario: HTML 路径 URL 变更
- **WHEN** 同 URL 变更通过 HTML 文件路径同步（无书签 ID）
- **THEN** 旧 URL 的同步书签被删除、新 URL 作为新同步书签插入

#### Scenario: 后同步浏览器覆盖
- **WHEN** Chrome 与 Edge 均同步过，两浏览器对同 URL 标题不同，后执行同步的浏览器
- **THEN** 该 URL 同步书签的 name 取后同步浏览器标题

### Requirement: 对齐字段范围

同步 SHALL 仅对齐 name、url、catelog（分类）三个字段。visibility、sort_order、hits、desc、logo SHALL 为本地属性，同步不写入。

#### Scenario: 本地属性保留
- **WHEN** 同步书签在 StarNav 中被调整过排序与可见性，随后执行同步
- **THEN** 排序、可见性、访问次数、描述、logo 保持用户调整值不变

### Requirement: 分类映射

浏览器文件夹 SHALL 拍平为「父/子」字符串映射为分类，缺失分类 SHALL 新建；分类改名/删除 SHALL 不传播。root 根（书签栏/其他书签/移动设备书签）SHALL 不建分类，其顶层书签归「未分类」。同步范围 SHALL 含全部收藏（含移动设备书签）。

#### Scenario: 嵌套文件夹拍平
- **WHEN** 浏览器书签位于 工作 > 开发 文件夹
- **THEN** 分类为「工作/开发」（新建），书签归入该分类

#### Scenario: 顶层书签归未分类
- **WHEN** 浏览器书签直接位于书签栏根（无自定义文件夹）
- **THEN** 该书签 catelog 为「未分类」

#### Scenario: 分类删除不传播
- **WHEN** 浏览器删除了某文件夹，执行同步
- **THEN** StarNav 中对应分类保留（仅书签的 catelog 按新文件夹位置对齐或归未分类）

### Requirement: 双入口

同步 SHALL 提供两个入口且共用同一后端对齐管线：扩展 popup「一键同步」按钮（`chrome.bookmarks.getTree()` 全量快照，manifest 含 `bookmarks` 权限）与后台书签 HTML 文件上传（浏览器端 DOMParser 解析 Netscape 格式）。文件路径 SHALL 同样执行全量对齐（含删除），提交前 SHALL 展示确认信息（含「将删除 N 项」警示）并支持仅预览差异。

#### Scenario: 扩展一键同步
- **WHEN** 用户在扩展 popup 点击「一键同步」
- **THEN** 扩展读取全部收藏并提交，完成后展示 新增/更新/删除/跳过/失败 计数

#### Scenario: 文件上传全量对齐
- **WHEN** 用户上传 bookmarks.html 并确认（删除数已展示）
- **THEN** 按文件内容执行全量对齐，与扩展路径语义一致

#### Scenario: 文件上传预览
- **WHEN** 用户先点击「预览」而非确认
- **THEN** 展示将新增/更新/删除的条目清单，不写入任何数据

#### Scenario: 选区导出保护
- **WHEN** 文件为选区导出、不含部分同步书签 URL
- **THEN** 确认框展示这些同步书签将被删除，用户确认后才执行

### Requirement: 删除安全

同步删除 SHALL 在删除前写操作日志（action 标识同步删除，含被删 URL、标题、时间）。不做回收站。

#### Scenario: 删除留痕
- **WHEN** 同步删除任一同步书签
- **THEN** `operation_logs` 新增记录：action、被删站点 URL、标题、执行时间

### Requirement: 鉴权与整站锁兼容

同步 API SHALL 接受管理员会话或有效 Bearer Token；整站锁启用时 SHALL 通过既有 API 凭据门禁（锁 Cookie、有效 Bearer Token 或管理员会话任一即可）。扩展路径使用现有 Bearer token 机制。

#### Scenario: 扩展 token 同步
- **WHEN** 整站锁已启用，扩展携带有效 Bearer Token 调用同步 API
- **THEN** 请求通过门禁，同步正常执行

#### Scenario: 匿名被拒
- **WHEN** 无任何凭据调用同步 API
- **THEN** 返回 403

### Requirement: 结果报告

同步 SHALL 返回并展示结果统计：新增、更新、删除、跳过、失败计数；失败的条目 SHALL 单独列出（URL + 原因），不阻塞其余条目处理。

#### Scenario: 部分失败继续
- **WHEN** 快照中一条书签 URL 非法、其余正常
- **THEN** 非法条目录入失败清单，其余条目正常对齐，报告展示失败明细

### Requirement: 空快照保护

同步 SHALL 在浏览器快照不含任何书签（URL 条目数为 0）时拒绝执行，返回明确错误且不产生任何新增、更新或删除。该拦截 SHALL 由服务端权威执行，扩展与文件路径客户端 SHALL 仅在提交前作前置提示。

#### Scenario: 空收藏夹拒绝同步
- **WHEN** 浏览器收藏为空（或上传的 bookmarks.html 不含任何书签），执行一键同步
- **THEN** 同步被拒绝并提示"未发现可同步的书签"，StarNav 数据零变化

#### Scenario: 服务端兜底拦截
- **WHEN** 客户端绕过校验提交空 items 数组
- **THEN** 服务端返回 400 且不执行任何对齐操作，同步书签全部保留
