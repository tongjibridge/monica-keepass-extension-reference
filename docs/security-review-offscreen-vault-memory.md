# Offscreen 密码库内存驻留安全审查与 P0 影响评估

## 文档信息

- 审查对象：Monica KeePass 浏览器扩展
- 审查范围：`extension` 运行时代码、`kdbxweb` 依赖实现、扩展消息协议与 Offscreen 生命周期
- 审查日期：2026-07-14
- 审查方式：由 `glm-agent` 进行独立全库只读调研，主代理复核关键数据流与依赖实现
- 文档性质：安全审查与修改方案，不代表已完成代码修复

## 1. 审查结论

原始问题“解锁后的完整数据库明文长期驻留 WebAssembly/JS 堆内存”**部分成立，核心安全风险实质成立，但技术表述需要修正**。

更准确的描述是：

> `.kdbx` 解锁时，KDBX 外层密文会被整体解密、解压和解析，完整数据库对象模型随后长期驻留 Offscreen Document。密码、OTP 等受保护字段通常不是持续保存为连续明文，而是以 `ProtectedValue(value, salt)` 形式保存在同一 JS 堆；能够读取该堆的攻击者可通过 `value XOR salt` 恢复秘密。当前锁定流程主要释放引用，没有完整的主动覆盖和 Offscreen 销毁，且代码中还存在 Argon2 派生材料、待保存密码及 content script 去重字符串等额外长期副本。

综合风险等级：**High（高）**。

该等级的适用前提是攻击者具备下列能力之一：

- 浏览器内核、扩展 renderer 或同扩展可信上下文代码执行能力；
- 调试、崩溃转储、系统内存取证或本机高权限；
- 能够有效读取目标浏览器进程内存的侧信道能力。

普通网页或另一个恶意扩展在正常 Chrome 隔离模型下不能天然直接读取 Offscreen 堆。因此，“浏览器扩展处于共享进程空间，所以任意恶意扩展可以直接读取密码库”不是准确的攻击描述。Native Messaging 的独立进程仍然能显著缩小浏览器进程失陷时的全库暴露面。

## 2. 已证实的代码事实

### 2.1 完整数据库对象长期驻留 Offscreen

- `extension/src/vault/engine.ts:15-19` 明确声明全局变量 `db: Kdbx | null`，注释说明其用于在长生命周期 Offscreen Document 中持有已解密密码库。
- `extension/src/vault/engine.ts:157-165` 调用 `Kdbx.load()` 后将结果赋给全局 `db`。
- `extension/entrypoints/background.ts:687-693` 创建 Offscreen Document 时，`justification` 明确写明用于在内存中持有已解密 KeePass 密码库并运行 Argon2。

结论：解锁期间，完整 `Kdbx` 对象模型确实长期驻留 Offscreen 的 JS 执行环境。

### 2.2 KDBX 外层数据会整体解密和解析

`extension/node_modules/kdbxweb/lib/format/kdbx-format.ts:66-94` 的 KDBX 4 加载流程依次执行：

1. 校验并解密完整数据块；
2. 必要时进行 GZip 解压；
3. 读取内部头部；
4. 将剩余数据通过 `bytesToString(data)` 转换为完整 XML 字符串；
5. 调用 `XmlUtils.parse(xmlStr)` 解析数据库；
6. 将解析结果转换成 `Kdbx` 对象模型。

结论：标准 KDBX 外层加密不是可直接按条目随机访问的存储结构。当前技术栈必须整体打开外层容器后才能搜索或取得条目。

### 2.3 受保护字段不是持续明文，但可由同堆数据直接恢复

`extension/node_modules/kdbxweb/lib/crypto/protected-value.ts:11-18` 显示 `ProtectedValue` 同时保存：

- `value: Uint8Array`；
- `salt: Uint8Array`。

`extension/node_modules/kdbxweb/lib/crypto/protected-value.ts:89-100` 的 `getText()`/`getBinary()` 通过逐字节 `value XOR salt` 生成秘密明文。

这比长期保存直接明文更好，但不是安全边界。对能够读取同一 JS 堆的攻击者而言，`value` 和 `salt` 可同时取得，无需再次输入主密码即可恢复秘密。

### 2.4 列表查询会无必要地批量生成密码明文

`extension/src/vault/engine.ts:123-132` 的 `summarize()` 为计算 `hasPassword`，对 Password 字段调用 `fieldText(password)`。

`extension/src/vault/engine.ts:99-102` 的 `fieldText()` 遇到 `ProtectedValue` 会调用 `getText()`。

`extension/src/vault/engine.ts:239-241` 的 `listEntries()` 对密码库中的所有条目执行 `summarize()`。

因此，每次列表、匹配及部分捕获流程都可能逐条生成全库密码明文字符串。虽然这些字符串不一定同时长期存活，但它们是不可主动覆盖的 JS 字符串，会扩大堆快照和 GC 残留面。

### 2.5 当前锁定只释放引用

`extension/src/vault/engine.ts:180-183` 当前只执行：

```ts
db = null;
clearArgon2Cache();
```

没有遍历和覆盖：

- 当前条目及历史条目的 `ProtectedValue.value/salt`；
- KDBX credentials 中的 password/key-file hash；
- 受保护附件和相关二进制缓冲区；
- 可访问的 header、派生材料及临时缓冲区。

锁定后也没有调用 `chrome.offscreen.closeDocument()`。因此，锁定仅表示业务层不再持有入口引用，不能证明相关内存已被覆盖或执行环境已被销毁。

### 2.6 Argon2 缓存含长期敏感材料

`extension/src/crypto/argon2.ts:10-17` 定义会话级 `cacheKey` 和 `cacheValue`。

`extension/src/crypto/argon2.ts:40-68` 将 KDF 输入与 salt 编码后拼接为不可变 JS 字符串，并保存 Argon2 输出缓冲区。

`extension/src/crypto/argon2.ts:32-35` 的 `clearArgon2Cache()` 只将引用设为 `null`，没有覆盖 `cacheValue`，也无法覆盖已经生成的字符串 `cacheKey`。

其中 `cacheValue` 属于高价值会话派生材料。直接删除全部缓存会导致每次保存都重新运行 Argon2，因此整改需要同时保护保存性能。

### 2.7 待保存的新密码进入 session storage

- `extension/src/autofill/suggest.ts:22-35` 的 `PendingSuggestion` 包含字符串字段 `newPassword`。
- `extension/entrypoints/background.ts:362-369` 将完整 suggestion 写入 `chrome.storage.session`。
- `extension/entrypoints/background.ts:138-141` 的手动锁定没有删除 pending 数据。
- `extension/entrypoints/background.ts:86-90` 的自动锁定同样只调用 Offscreen `lock`。

因此，用户没有点击“保存”或“忽略”时，新密码可能在锁定后继续存在于浏览器 session storage。

### 2.8 Content script 长期保存包含密码的字符串

- `extension/entrypoints/content.ts:647` 定义 `lastSent = ''`。
- `extension/entrypoints/content.ts:742-744` 将 kind、username、password、oldPassword 拼接为去重字符串，并保存到 `lastSent`。

该字符串通常会持续到下一次捕获或页面卸载，无法主动覆盖。

### 2.9 敏感数据经过多个 JS 字符串和消息副本

当前协议通过 runtime messaging 在 popup、content、background 和 offscreen 之间传递：

- 主密码；
- 条目密码和 OTP；
- key file 的 Base64 字符串；
- KDBX 文件的 Base64 字符串；
- 待保存的新旧密码。

完全禁止 JS 字符串在浏览器扩展中并不现实，因为表单控件、React state 和 DOM 输入最终都使用字符串。可行目标应是：秘密仅在必要边界短暂字符串化，减少复制，不进入通用 DTO、日志、缓存和长期状态。

### 2.10 Offscreen 消息边界缺少调用方限制

`extension/entrypoints/offscreen/main.ts:58-65` 只检查 `msg.target === 'offscreen'`，没有验证调用上下文、tab、origin、操作能力或一次性授权。

普通网页不能直接调用该接口，但任意同扩展上下文都可以发送通用 Offscreen 操作。一旦 content script 或扩展页面上下文被攻陷，攻击者可绕过 Background 的业务限制直接请求敏感操作。

## 3. 已有缓解措施

当前实现并非完全没有内存保护：

- 密码和 OTP 默认使用 `ProtectedValue`，避免持续保存为直接明文数组；
- `getEntry(id, reveal)` 在 DTO 层支持单条按需返回；
- 已实现 15 分钟滑动自动锁；
- `kdbxweb` 会对部分临时主密钥、cipher key 和 XML byte buffer 调用 `zeroBuffer()`；
- Chrome 正常安全模型会隔离网页、不同扩展和扩展上下文，普通网页不能直接读取 Offscreen 堆。

这些措施可以降低普通脚本或偶然内存暴露风险，但无法防御能够读取目标扩展堆的攻击者。

## 4. 与 KeePassXC-Browser 的边界对比

KeePassXC-Browser 官方说明其扩展通过 `keepassxc-proxy` 使用 Native Messaging 与 KeePassXC 桌面进程通信，代理再通过命名管道或 Unix domain socket 转发消息：

- <https://github.com/keepassxreboot/keepassxc-browser#how-it-works>

该架构使完整数据库和主凭据主要驻留 KeePassXC 桌面进程，浏览器只接收当前请求需要的数据。它不能阻止单次填充密码短暂进入浏览器，也不能抵御本机管理员直接读取 KeePassXC 进程，但显著降低了浏览器 renderer 被攻陷时的全库暴露面。

标准 KDBX 的外层密文覆盖完整 XML，因此当前纯浏览器方案无法简单添加一个“只解密某条记录”的 `kdbxweb` API。真正满足浏览器失陷隔离要求，需要 Native Messaging 或改变存储架构。

## 5. P0 修改范围与影响

P0 的目标是：在不改变 KDBX 文件格式和 OneDrive 文件兼容性的前提下，消除无必要的批量明文生成，缩短敏感数据生命周期，并让锁定动作尽可能销毁当前执行环境。

P0 不承诺：

- 在浏览器进程被完全控制时仍保护全部秘密；
- 对不可变 JS 字符串提供原生程序级 `zeroize` 保证；
- 在纯浏览器内实现真正的 KDBX 条目级外层随机访问解密。

### P0-1：修复 `summarize()` 的全库密码解密

#### 修改内容

- `ProtectedValue` 使用 `byteLength > 0` 判断 `hasPassword`，不调用 `getText()`。
- 对未受保护的字符串型 Password 字段仅检查字符串长度。
- 增加测试，确保 `listEntries()` 和 `match()` 不读取密码明文。

#### 影响

- 安全：消除列表、匹配时最明显的全库批量明文生成路径。
- 用户体验：无预期可见变化。
- 性能：列表和匹配略有提升，尤其是大密码库。
- 兼容性：不改变 KDBX 格式；需要保留对第三方 KDBX 中未标记为 Protected 的 Password 字段的兼容。
- 实现风险：低。

#### 失败模式

若只处理 `ProtectedValue` 而忽略字符串型 Password，可能错误显示 `hasPassword=false`。

#### 验收标准

- 有密码条目仍正确显示 `hasPassword=true`。
- 无密码条目仍为 `false`。
- 测试监控 `ProtectedValue.getText()`，执行 list/match 时调用次数为零。

### P0-2：重构 Argon2 会话缓存并主动清零

#### 修改内容

- 禁止将 KDF 输入和 salt 拼成字符串 `cacheKey`。
- 使用可覆盖的二进制标识或固定长度摘要进行缓存匹配。
- 会话内可继续保留 `cacheValue` 以保证保存性能。
- 在锁定、切换密码库、修改 KDF 或异常退出路径中，对缓存缓冲区执行 `fill(0)` 后释放引用。

#### 影响

- 安全：锁定后不再仅依赖 GC 回收高价值 Argon2 派生材料；消除长期不可变缓存键字符串。
- 用户体验：采用二进制缓存时无预期变化。
- 性能：正确实现后保存速度基本不变。
- 资源占用：解锁会话内仍会保留一个派生值，这是保存性能与驻留风险之间的明确权衡。
- 实现风险：中。

#### 不推荐做法

不能简单删除全部 Argon2 缓存。否则每次新增、修改或同步保存都可能重新运行高成本 Argon2，造成数秒延迟、高内存占用、风扇噪声和电池消耗。

#### 验收标准

- 同一解锁会话的连续保存仍命中缓存。
- 锁定后缓存缓冲区内容为零。
- KDF 参数变化后旧缓存立即被覆盖并失效。
- 源码中不再存在包含 KDF 输入的长生命周期字符串缓存。

### P0-3：实现统一 `secureLock(reason)` 和主动擦除

#### 修改内容

统一所有锁定入口，包括：

- 用户手动锁定；
- 自动锁定 alarm；
- 切换或导入密码库；
- 备份恢复；
- 扩展生命周期事件中的可用锁定机会。

在 `VaultEngine` 中尽最大可能覆盖：

- 当前条目及其历史中的 `ProtectedValue.value/salt`；
- credentials 中的 password hash 和 key-file hash；
- 受保护二进制及附件；
- 可访问的 header/key 缓冲区；
- Argon2 缓存和应用级临时缓冲区。

随后再将对象引用设为 `null`。

#### 影响

- 安全：显著降低锁定后通过堆残留恢复秘密的概率。
- 用户体验：正常密码库基本无感；超大密码库或大量历史/附件时，锁定可能出现短暂停顿。
- 性能：锁定复杂度约为受保护字段和附件总量的线性复杂度。
- 兼容性：不改变文件格式。
- 实现风险：中高。

#### 关键工程约束

擦除会不可逆地破坏当前内存对象。因此 `secureLock()` 必须与保存、同步、合并操作串行：

```text
停止接受新的 Vault 操作
→ 等待正在执行的保存/同步结束
→ 必要时完成最后一次持久化
→ 擦除敏感对象
→ 释放对象引用
```

若自动锁定恰好发生在保存或 OneDrive merge 中间，未经协调直接擦除可能造成：

- 保存失败；
- 同步中断；
- 尚未持久化的修改丢失；
- 异步任务继续访问已被清零的对象。

因此需要 Vault 操作互斥锁、锁定状态机和最大等待时间。最大等待超时后应以“优先锁定”为原则终止后续操作，并向用户明确报告未完成任务。

#### 验收标准

- 所有锁定入口最终都进入同一个 `secureLock()`。
- 锁定过程中不再接受读取、保存、填充或同步操作。
- 已完成的编辑在擦除前持久化。
- 锁定与保存/同步并发测试不出现文件损坏或静默丢数据。

### P0-4：锁定后关闭 Offscreen Document

#### 修改内容

- Offscreen 完成主动擦除并返回确认。
- Background 随后调用 `chrome.offscreen.closeDocument()`。
- 下次解锁时重新创建 Offscreen Document。

#### 影响

- 安全：销毁整个 JS 执行上下文，是对不可变字符串和无法完整遍历对象的必要补强。
- 用户体验：锁定后所有操作都必须重新解锁，符合密码库锁定语义。
- 解锁性能：下次解锁增加一次 Offscreen 创建开销；主要耗时仍然是 KDF 和 KDBX 加载。
- 稳定性：正在执行的填充、保存或同步会因关闭文档而失败，必须依赖 P0-3 的串行状态机。
- 实现风险：中。

#### 边界说明

关闭 Offscreen 可以销毁上下文并促使浏览器回收资源，但不能向操作系统层面证明所有物理内存页面已经立即覆盖，因此文档和产品描述不能宣称“绝对安全清零”。

#### 验收标准

- 手动锁定和自动锁定完成后，`chrome.offscreen.hasDocument()` 返回 `false`。
- 锁定后发送 Vault 操作会返回明确的 Locked 错误，而不是隐式重新创建空 Offscreen。
- 下次解锁能够正常重新创建并加载密码库。

### P0-5：清理 pending password 生命周期

#### 修改内容

- 返回给 content script 的提示 DTO 不再包含 `newPassword`。
- pending secret 不再以明文对象写入 `chrome.storage.session`。
- 可将秘密以 Offscreen `ProtectedValue` 短期保存，通过随机 opaque token 引用。
- token 绑定 tab、frame、origin 和创建时间。
- 设置几十秒级 TTL；应用、忽略、锁定、导航或超时后立即擦除。

#### 影响

- 安全：新密码不再进入长期 session storage，也不随提示 DTO 再次返回 content script。
- 用户体验：提示过期、页面跳转、Offscreen 被终止或密码库锁定后，未确认的保存请求会消失；用户需要再次提交登录表单。
- 稳定性：Background service worker 重启时，若 Offscreen 仍存在，token 可继续有效；Offscreen 被浏览器终止时 pending 请求会安全丢弃。
- 实现复杂度：中。

#### 产品取舍

安全优先的正确行为是“丢弃未确认密码”，而不是为了恢复提示而长期保存明文。UI 应显示提示有效期，过期后提供清晰说明。

#### 验收标准

- `chrome.storage.session` 中不再出现密码字段。
- content script 收到的提示 DTO 不含 `newPassword` 或 `oldPassword`。
- token 不能跨 tab、frame 或 origin 使用。
- 锁定后所有 token 立即失效并擦除。

### P0-6：移除 `content.lastSent` 中的密码

#### 修改内容

将当前包含密码的去重字符串改成非秘密去重机制，例如：

- 表单实例/字段组合标识加短 TTL；
- 随机会话键下的短期摘要；
- 最近一次提交的 DOM 元素弱引用和时间戳。

无论采用哪种方式，都不能把密码、旧密码或其可离线猜测的无盐摘要作为长期标识。

#### 影响

- 安全：消除页面生命周期内的明显明文密码副本。
- 用户体验：正确实现时无变化。
- 功能风险：去重不足可能重复弹出保存提示；去重过强可能漏掉真实密码更新。
- 实现风险：中。

#### 验收标准

- content script 的实例字段、闭包和长期字符串中不包含密码。
- 同一次提交不会重复提示。
- 同一页面后续真实密码变更仍能触发新提示。
- 页面导航、锁定或 TTL 到期后去重状态被清理。

### P0-7：缩短 Popup 主凭据状态生命周期

#### 修改内容

- 解锁成功后尽快清空 React state 中的主密码和 key-file Base64。
- Windows Hello 注册与首次解锁合并为原子流程，或注册时要求重新验证。
- 已解锁状态下的 OneDrive merge 尽量复用 Offscreen 内部凭据能力，不继续依赖 Popup 保存主密码。
- 锁定状态需要合并时明确要求重新输入凭据。

#### 影响

- 安全：缩短主密码及 key file 在 Popup JS 字符串中的驻留时间。
- 用户体验：Windows Hello 注册、备份或某些同步场景可能要求用户重新输入凭据。
- 功能兼容：如果直接调用 `setCredential(null)` 而不重构依赖流程，会导致当前 Windows Hello 注册和部分 OneDrive 操作不可用。
- 实现风险：中高。

#### 验收标准

- 普通解锁完成后，Popup 不再为了未来操作长期保存主凭据。
- Windows Hello 注册仍可完成，并明确要求相应认证。
- OneDrive 同步/合并不依赖长生命周期 Popup 主密码状态。
- Popup 关闭后不存在需要跨 Popup 恢复的明文凭据。

### P0-8：增加安全回归测试

#### 修改内容

增加以下自动化测试：

- list/match 不读取 Password 明文；
- 锁定覆盖受保护缓冲区并清除 Argon2 缓存；
- 锁定后 Offscreen 被关闭；
- pending secret 不进入 session storage；
- content 去重状态不含密码；
- content 不能直接调用通用 Offscreen 敏感操作；
- 锁定与保存、同步并发时不损坏文件、不静默丢数据。

#### 影响

- 用户体验和运行时性能：无直接影响。
- 工程成本：增加测试桩、Chrome API mock 和维护成本。
- 发布收益：降低以后重构重新引入明文副本或锁定竞态的概率。
- 实现风险：低。

## 6. P0 综合影响矩阵

| P0 项目 | 安全收益 | 用户可感知影响 | 性能影响 | 实现风险 |
|---|---|---|---|---|
| P0-1 禁止列表解密密码 | 高 | 无 | 略有改善 | 低 |
| P0-2 Argon2 缓存清零 | 高 | 正确实现时无 | 应保持不变 | 中 |
| P0-3 `secureLock()` 擦除 | 高 | 大库锁定可能短暂停顿 | 锁定时线性开销 | 中高 |
| P0-4 关闭 Offscreen | 高 | 锁定后必须重新解锁 | 下次解锁略增创建开销 | 中 |
| P0-5 pending token/TTL | 高 | 未确认提示可能过期或丢弃 | 很低 | 中 |
| P0-6 移除 `lastSent` 密码 | 中高 | 可能出现去重行为回归 | 很低 | 中 |
| P0-7 清理 Popup 凭据 | 中高 | 部分操作需要重新验证 | 很低 | 中高 |
| P0-8 安全回归测试 | 间接高 | 无 | 无运行时影响 | 低 |

## 7. 推荐实施顺序

建议按以下依赖顺序实施：

1. P0-1：先消除全库列表时的无必要明文生成。
2. P0-2：重构 Argon2 缓存，建立统一可清零缓冲区工具。
3. P0-6：移除 content script 的明文去重字符串。
4. P0-5：重构 pending secret 与提示 DTO。
5. P0-3：实现 Vault 互斥、锁定状态机和主动擦除。
6. P0-4：在稳定的 `secureLock()` 基础上关闭 Offscreen。
7. P0-7：重构 Windows Hello、OneDrive 与 Popup 凭据依赖。
8. P0-8：测试应随各项同步加入，并在 P0 结束时补齐端到端锁定测试。

P0-4 不能先于 P0-3独立上线，否则自动锁定可能在保存或同步中间直接销毁执行环境。P0-7 也不能通过简单清空 state 单独完成，否则会造成现有功能回归。

## 8. P0 完成后的剩余风险

完成 P0 后仍然存在以下不可消除的纯浏览器限制：

- 解锁操作瞬间仍需整体打开 KDBX 外层容器；
- 解锁期间 `ProtectedValue.value/salt` 仍位于同一浏览器安全域；
- 填充、显示和复制时，单条密码仍必须短暂成为字符串并进入 DOM 或剪贴板；
- 浏览器进程被完全控制时，攻击者仍可能读取当前解锁数据库；
- JavaScript 无法为所有不可变字符串和 GC 副本提供可验证的物理清零保证。

因此，P0 的安全承诺应限定为：

> 消除无必要的全库明文生成和明显长期副本；在锁定时尽最大可能覆盖可变缓冲区并销毁 Offscreen 执行环境；显著缩短秘密在浏览器内的驻留时间。

如果目标是抵御浏览器 renderer 或扩展进程失陷后的全库提取，应进入架构级改造：由 Native Messaging 独立桌面进程持有数据库和主凭据，扩展只获取当前操作所需的单条字段。
