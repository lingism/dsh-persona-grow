# 本体改动说明（相对 npm 版 0.4.0）

这个仓库是 `dsh-persona-grow@0.4.0` 的**带补丁版本**，改动只有一处，在 `lib/index.js` 的提示词拼装函数里。

## 改了行为

**原来的预算分配**（按类别顺序吃）：

```js
for (const kind of KINDS) {          // trait → preference → speech → memory → boundary → bond
  for (const entry of group) {
    if (used + cost + line.length + 1 > budget) continue;   // 超了跳过
  }
}
```

因为类别顺序固定、且 `continue` 只跳过不中断，**预算一紧，最先整段消失的永远是 `bond`（我们之间）、`boundary`（底线）、`memory`（共同记忆）**——恰恰是最不该丢的三类。

**现在的预算分配**（跨类别按强度竞争）：

```js
// 先让所有条目按有效强度（effectiveStrength）竞争预算位置
const admitted = new Set();
for (const { entry } of live) {          // live 已按 strength 降序
  if (pool + line.length + 1 > budget) continue;
  admitted.add(entry); pool += line.length + 1;
}
// 展示顺序仍是 KINDS，保证读起来不变
for (const kind of KINDS) {
  const group = live.filter(i => i.entry.kind === kind && admitted.has(i.entry));
  ...
}
```

效果：

- `locked: true` 的条目、当前有效强度高的条目，**永远优先占到位置**；
- 被时间衰减到低星的、长期没被印证的条目先出局；
- 展示顺序不变，读起来还是原来的分段。

## 为什么不做"轮换注入"

轮换会让"本轮没轮到的条目"在这一轮完全不存在——人格断片，比固定截断更不可控；而且每轮前缀不同会破坏 API 的上下文缓存，反而更贵。

## 怎么回滚

把这段循环改回按 KINDS 顺序吃预算即可。原实现见 git 历史的第一版提交。

## 配套

- 注入总量自检：`tools/health-check.cjs`（会算 `字符数 / maxChars` 的百分比，>75% 警告、>100% 失败）
- 建议 `maxChars` 不低于实际用量的 2 倍留余量。
