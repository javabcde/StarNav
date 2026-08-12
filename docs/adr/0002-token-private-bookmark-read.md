# 有效 Bearer Token 授予私人书签读取

插件「站内书签浏览」需要看到私人书签分类，而现有读接口（`/search`、`/ai/chat`、`/config` GET）的 `privateAccess` 只认管理员会话或私人书签密码 Cookie，不认 Bearer Token。决定：任何有效（未吊销）Bearer Token 都计入 `privateAccess`——token 是密码级凭据，等价于"知道私人书签密码的人可见"的既有语义。

Status: accepted

## 决策要点

- 改 `api.js` 三处 `privateAccess` 计算：`adminAuthed || 有效 token || hasPrivateBookmarkAccess`。
- 不区分 token scope：写专用 token 同样可读私人书签（token 由管理员自建，授予即信任）。
- 拒绝的替代：scope 区分（token 模型无 read/private 维度，需建新机制）、专用授权开关（过度设计）、token 不可见（插件浏览失去私人书签，功能不完整）。
- 匿名访问仍不可见私人书签；整站锁下 token 过门禁不受影响。

## Consequences

- 任何持有 token 的第三方脚本（开放 API 场景）都能读私人书签——与"持有密码即可解锁"语义一致，文档需写明。
- 吊销 token 立即撤销私人读取能力（KV token 校验）。
- 未来若引入更细粒度 token scope，此语义需重审。
