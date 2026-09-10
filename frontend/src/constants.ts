/**
 * Shared constants used across ConfigPanel and WorkflowConfigPanel.
 */

import pkg from '../package.json';
import shareGPTData from './data/sharegpt-prompts.json';

export const APP_VERSION = `v${pkg.version}`;

/** Product branding — single source of truth for the name shown in the UI. */
export const APP_NAME = 'Uni LLM Bench';
export const APP_TAGLINE = 'Unified LLM API benchmarking';
export const COPYRIGHT_HOLDER = 'Uni LLM Bench';
export const COPYRIGHT_YEAR = String(new Date().getFullYear());

export type PresetCategory = 'standard' | 'long-context';

export interface PresetPrompt {
  id?: string;
  labelKey: string;
  label: string;
  prompt: string;
  tokens: number;
  category: PresetCategory;
  /** Heavy presets are loaded on demand via loadHeavyPreset() */
  heavy?: boolean;
  /** Whether the prompt contains multiple documents and supports output scope control */
  multiDoc?: boolean;
}

function longContextPreset(
  bucket: keyof typeof shareGPTData.buckets,
  label: string,
  labelKey: string,
  index = 0,
  multiDoc = false,
): PresetPrompt {
  const item = shareGPTData.buckets[bucket][index];
  return { labelKey, label, prompt: item.text, tokens: item.tokens, category: 'long-context', multiDoc };
}

function heavyPreset(bucket: '64k' | '150k' | '256k', labelKey: string): PresetPrompt {
  const labels: Record<string, string> = {
    '64k': 'Long Context 64K',
    '150k': 'Long Context 150K',
    '256k': 'Long Context 256K',
  };
  const tokensMap: Record<string, number> = { '64k': 64_000, '150k': 150_000, '256k': 256_000 };
  return {
    labelKey,
    label: labels[bucket],
    prompt: '',
    tokens: tokensMap[bucket],
    category: 'long-context',
    heavy: true,
    multiDoc: true,
  };
}

export async function loadHeavyPreset(bucket: '64k' | '150k' | '256k', index = 0): Promise<string> {
  if (bucket === '64k') {
    const mod = await import('./data/sharegpt-64k.json');
    return (mod as any).default.buckets['64k'][index].text;
  } else if (bucket === '150k') {
    const mod = await import('./data/sharegpt-150k.json');
    return (mod as any).default.buckets['150k'][index].text;
  } else {
    const mod = await import('./data/sharegpt-256k.json');
    return (mod as any).default.buckets['256k'][index].text;
  }
}

export const PRESET_PROMPTS: PresetPrompt[] = [
  {
    labelKey: 'presets.generalKnowledge',
    label: '通用知识',
    prompt: '请用通俗易懂的语言，向一名 10 岁的小朋友解释什么是量子计算，以及它和我们平时用的电脑有什么不同。',
    tokens: 28,
    category: 'standard',
  },
  {
    labelKey: 'presets.codeGeneration',
    label: '代码生成',
    prompt:
      '用 TypeScript 实现一个二叉搜索树（Binary Search Tree），支持插入、查找和删除三种操作，并给关键方法加上中文注释。',
    tokens: 42,
    category: 'standard',
  },
  {
    labelKey: 'presets.creativeWriting',
    label: '创意写作',
    prompt: '写一篇关于一个 AI 突然发现自己能够做梦的短篇科幻小说，字数控制在 300 字左右，结尾留一点悬念。',
    tokens: 32,
    category: 'standard',
  },
  {
    labelKey: 'presets.analysis',
    label: '文本分析',
    prompt: '请对比微服务架构与单体架构的优缺点，说明各自适用的业务场景，并给出技术选型建议。',
    tokens: 38,
    category: 'standard',
  },
  {
    labelKey: 'presets.jsonExtract',
    label: '信息抽取',
    prompt:
      '请从以下中文新闻中抽取关键信息，并以 JSON 格式返回，字段包括：企业、事件、金额（单位：元）、日期。\n\n文本：某科技公司今日宣布完成 5 亿元 B 轮融资，资金将用于大模型研发与算力基础设施建设，交易于 2026 年 3 月 12 日正式交割。',
    tokens: 78,
    category: 'standard',
  },
  {
    labelKey: 'presets.summarization',
    label: '中文摘要',
    prompt:
      '请将以下工作汇报压缩为 3 条核心要点，每条不超过 30 字，保留关键结论与数据：\n\n本季度营收 2.3 亿元，同比增长 47%；新签客户 312 家，企业级客户占比 68%；研发投入 5100 万元，上线 3 个核心模型；客户留存率提升至 91%，但获客成本上升 12%。',
    tokens: 82,
    category: 'standard',
  },
  {
    labelKey: 'presets.rewritePolish',
    label: '改写润色',
    prompt:
      '请将下列口语化表达改写为正式、得体的书面语，保持原意不变：\n\n我们这个方案吧，说实话成本确实不低，但效果是真的好，客户那边反馈也很正面。',
    tokens: 46,
    category: 'standard',
  },
  {
    labelKey: 'presets.mathReasoning',
    label: '数学推理',
    prompt:
      '某电商大促优惠规则如下：① 满 300 减 50；② 可叠加店铺券满 200 减 30；③ 最终再享 9 折。一件原价 599 元的商品，最终到手价是多少？请逐步推理并给出答案。',
    tokens: 58,
    category: 'standard',
  },
  longContextPreset('1k', 'Long Context 1K', 'presets.longContext1k'),
  longContextPreset('4k', 'Long Context 4K', 'presets.longContext4k'),
  longContextPreset('16k', 'Long Context 16K', 'presets.longContext16k', 0, true),
  heavyPreset('64k', 'presets.longContext64k'),
  heavyPreset('150k', 'presets.longContext150k'),
  heavyPreset('256k', 'presets.longContext256k'),
];

export const QUICK_MAX_TOKENS = [
  { label: '512', value: 512 },
  { label: '4K', value: 4096 },
  { label: '16K', value: 16384 },
];

export const QUICK_CONCURRENCY = [
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '50', value: 50 },
  { label: '200', value: 200 },
  { label: '500', value: 500 },
  { label: '1K', value: 1000 },
  { label: '2K', value: 2000 },
  { label: '5K', value: 5000 },
];

export const QUICK_ITERATIONS = [
  { label: '10', value: 10 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '500', value: 500 },
  { label: '2K', value: 2000 },
  { label: '10K', value: 10000 },
  { label: '100K', value: 100000 },
  { label: '1M', value: 1000000 },
  { label: '5M', value: 5000000 },
  { label: '10M', value: 10000000 },
];

export const QUICK_WARMUP = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
];

export const QUICK_INTERVAL = [
  { label: 'None', labelKey: 'common.status.off', value: 0 },
  { label: '100', value: 100 },
  { label: '500', value: 500 },
  { label: '1000', value: 1000 },
];

export const DEFAULT_MAX_TOKENS = 16384;

const MAX_TOKENS_STORAGE_KEY = 'llm-radar:max-tokens';

export function getStoredMaxTokens(): number {
  try {
    const v = localStorage.getItem(MAX_TOKENS_STORAGE_KEY);
    return v !== null ? Number(v) : DEFAULT_MAX_TOKENS;
  } catch {
    return DEFAULT_MAX_TOKENS;
  }
}

export function storeMaxTokens(v: number): void {
  try {
    localStorage.setItem(MAX_TOKENS_STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
}

const OUTPUT_SCOPE_STORAGE_KEY = 'llm-radar:output-scope';

export function getStoredOutputScope(): number {
  try {
    const v = localStorage.getItem(OUTPUT_SCOPE_STORAGE_KEY);
    return v !== null ? Number(v) : -1;
  } catch {
    return -1;
  }
}

export function storeOutputScope(value: number): void {
  try {
    localStorage.setItem(OUTPUT_SCOPE_STORAGE_KEY, String(value));
  } catch {
    /* ignore */
  }
}

export const OUTPUT_SCOPE_OPTIONS = [
  { label: 'First 3 docs', value: 3 },
  { label: 'First 5 docs', value: 5 },
  { label: 'First 10 docs', value: 10 },
  { label: 'All docs', value: -1 },
];

/**
 * Strip the trailing instruction from a long-context prompt and replace it
 * with one that limits the scope of reading (and therefore output length).
 *
 * scope > 0   → "Only read the first N documents …"
 * scope === -1 → "For each document above …" (all docs)
 */
export function applyOutputScope(prompt: string, scope: number): string {
  const idx = prompt.lastIndexOf('\n\n');
  if (idx === -1) return prompt;
  const base = prompt.slice(0, idx);
  const suffix =
    scope > 0
      ? `Only read the first ${scope} documents above. For each of those ${scope} documents, identify its topic in one short phrase. Output as a numbered list.`
      : "Don't overthink this. For each document above, identify its topic in one short phrase. Output as a numbered list, keep it brief.";
  return `${base}\n\n${suffix}`;
}

export const QUICK_QPS = [
  { label: 'Off', labelKey: 'common.status.off', value: 0 },
  { label: '0.1', value: 0.1 },
  { label: '0.2', value: 0.2 },
  { label: '0.5', value: 0.5 },
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
];
