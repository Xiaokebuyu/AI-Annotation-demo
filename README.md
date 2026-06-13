# InkLoop

PDF 标注实时闭环的 A 组验证工程：在原文上圈、划、写，停笔后 AI 以**旁注低语**的形式在标注旁轻声指路。

> 第一周定位：用 web 验证交互与数据闭环（决策 D2 —— 脚手架运行时可换，设计语言与契约迁移到硬件）。

## 运行

```bash
npm install
npm run dev      # http://localhost:8765
npm run check    # tsc 严格类型检查
npm run build    # 类型检查 + 生产构建
```

`?dev=1` 或按 `d` 唤出开发面板（OCR/推理 provider 切换、坐标自测、分段延迟、trace）。

## 架构

```
src/
  core/         纯逻辑，无 DOM
    contracts.ts  七个 v0 数据契约（D1 归一化坐标 / D3 stroke 无损 / D4 version）
    transform.ts  坐标换算唯一入口（normToPx/pxToNorm）+ 自测
    classify.ts   笔画几何分类（circle/underline/tap_region/stroke）
    pipeline.ts   recordEvent（逐笔无损）+ commitSession（停笔会话→OCR→推理→低语）
    ids / trace / metrics
  providers/    可替换接缝（契约即接口，B 组在此接入真实现）
    ocr.ts        textlayer(真实) / mock / vlm(stub) / local(B组)
    inference.ts  mock / fail(测A11) / cloud(stub)
  ui/           DOM 层，各管一块
    renderer.ts   PDF.js 渲染 + text layer 提取
    ink.ts        Pointer Events 无损采集 + 压感笔迹 + 橡皮/撤销
    whisper.ts    旁注低语：贴标注旁、逐句淡入、收下/改写/散去
    insight-panel.ts  本页洞察侧栏（默认隐藏，只读历史）
    toolbar / dev-drawer
  app/state.ts  事件总线 + 全局状态
  main.ts       装配 + 停笔窗口 debounce + 拖拽上传
legacy/         改造前的单文件 demo 留档
```

## 交互要点

- **停笔会话**：抬笔后 1.2s 静默窗口内的多笔合并为一次低语（避免一圈三条）；每笔仍独立 trace（B 组原料无损）。
- **旁注低语**：非卡片，斜体灰字贴在标注旁，逐句淡入（电子纸不逐字流式），hover 才显现收下/改写/散去。
- **坐标闭环**：所有 geometry 走页面归一化坐标，缩放/翻页位置不漂移；开发面板「坐标自测」往返误差为 0。

## 接缝（后续替换点）

| 位置 | 现状 | 接入方 |
| --- | --- | --- |
| `providers/ocr.ts` textlayer | 数字版 PDF 真实文本（免 OCR） | — |
| `providers/ocr.ts` vlm / local | stub | 周一提案后 / B 组 B3 |
| `providers/inference.ts` cloud | stub | AB1 定稿后经 API client（A8） |
