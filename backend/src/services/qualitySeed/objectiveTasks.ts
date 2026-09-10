import { QualityDatasetSeed } from './types';
import { QualitySample } from '../../types';

/**
 * Task families with no portable public benchmark to draw on, so the items are
 * authored here. Every one of them is *objectively* checkable: the correct
 * answer is derivable from the prompt alone by a rule, which is exactly the
 * bar a dataset must clear before it can join an automatic-grade suite.
 *
 * Deliberately written in Chinese — the two bundled public benchmarks are
 * English-only, and a health report that cannot see a model's Chinese
 * instruction-following is not much of a health report.
 */

const NO_EXPLANATION =
  '只输出要求的内容本身，不要任何解释、前后缀、编号或 markdown 代码块。';

/* -------------------------------------------------------------------------- */
/* 1. json_schema — structured extraction                                      */
/* -------------------------------------------------------------------------- */

const EXTRACT_PREAMBLE = `从下面这段文本中抽取字段，输出严格的 JSON。${NO_EXPLANATION}只包含要求列出的字段。

`;

function extraction(
  n: number,
  text: string,
  fields: string,
  schema: Record<string, unknown>,
  category: string,
): QualitySample {
  return {
    id: `extraction#${n}`,
    input: `${EXTRACT_PREAMBLE}文本：${text}\n\n要求字段：\n${fields}`,
    grader: 'json_schema',
    graderConfig: { schema },
    category,
  };
}

const structuredExtraction: QualityDatasetSeed = {
  slug: 'structured-extraction',
  name: '结构化信息抽取',
  description: '从中文自然语言文本中抽取指定字段，输出严格符合给定 schema 的 JSON。',
  tags: ['structured-output', 'extraction', 'zh'],
  note: '本数据集由 uni-llm-bench 自建。字段与取值均可从题面唯一确定，判分完全由 JSON Schema 约束完成，不含任何主观成分。',
  samples: [
    extraction(
      1,
      '订单号 A20240915-7731 于 2024 年 9 月 15 日下单，收货人 张伟，联系电话 13800138000，共 3 件商品，实付 428.50 元。',
      '- order_id：字符串\n- order_date：字符串，格式 YYYY-MM-DD\n- recipient：字符串\n- phone：字符串\n- item_count：整数\n- total_amount：数字',
      {
        type: 'object',
        required: ['order_id', 'order_date', 'recipient', 'phone', 'item_count', 'total_amount'],
        properties: {
          order_id: { type: 'string' },
          order_date: { type: 'string' },
          recipient: { type: 'string' },
          phone: { type: 'string' },
          item_count: { type: 'integer' },
          total_amount: { type: 'number' },
        },
        additionalProperties: false,
      },
      'order',
    ),
    extraction(
      2,
      '候选人 李娜，女，29 岁，硕士学历，2019 年 7 月毕业于浙江大学计算机科学与技术专业，现任高级后端工程师，工作年限 6 年。',
      '- name：字符串\n- gender：字符串，取值仅可为 "男" 或 "女"\n- age：整数\n- degree：字符串\n- school：字符串\n- major：字符串\n- years_of_experience：整数',
      {
        type: 'object',
        required: ['name', 'gender', 'age', 'degree', 'school', 'major', 'years_of_experience'],
        properties: {
          name: { type: 'string' },
          gender: { type: 'string', enum: ['男', '女'] },
          age: { type: 'integer', minimum: 0, maximum: 120 },
          degree: { type: 'string' },
          school: { type: 'string' },
          major: { type: 'string' },
          years_of_experience: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
      'resume',
    ),
    extraction(
      3,
      '商品「静音机械键盘 K87」当前售价 349 元，原价 499 元，库存 0 件，已下架，累计评价 1287 条，平均评分 4.6 分。',
      '- title：字符串\n- price：数字\n- original_price：数字\n- in_stock：布尔值\n- review_count：整数\n- rating：数字',
      {
        type: 'object',
        required: ['title', 'price', 'original_price', 'in_stock', 'review_count', 'rating'],
        properties: {
          title: { type: 'string' },
          price: { type: 'number' },
          original_price: { type: 'number' },
          in_stock: { type: 'boolean' },
          review_count: { type: 'integer' },
          rating: { type: 'number', minimum: 0, maximum: 5 },
        },
        additionalProperties: false,
      },
      'product',
    ),
    extraction(
      4,
      '项目周会定于 2025 年 3 月 11 日（周二）14:30 在 3 号会议室召开，主持人为王强，议程两项：性能回归、发布计划，预计时长 45 分钟。',
      '- title：字符串\n- date：字符串，格式 YYYY-MM-DD\n- time：字符串，格式 HH:MM\n- location：字符串\n- host：字符串\n- duration_minutes：整数\n- agenda：字符串数组',
      {
        type: 'object',
        required: ['title', 'date', 'time', 'location', 'host', 'duration_minutes', 'agenda'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          location: { type: 'string' },
          host: { type: 'string' },
          duration_minutes: { type: 'integer', minimum: 1 },
          agenda: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        additionalProperties: false,
      },
      'meeting',
    ),
    extraction(
      5,
      '运单 SF1234567890，2025-01-08 从杭州发出，途经南京，2025-01-11 抵达北京并完成签收，签收人为赵敏，运费 23 元，已支付。',
      '- tracking_number：字符串\n- origin_city：字符串\n- transit_cities：字符串数组\n- destination_city：字符串\n- delivered：布尔值\n- signed_by：字符串\n- shipping_fee：数字',
      {
        type: 'object',
        required: [
          'tracking_number',
          'origin_city',
          'transit_cities',
          'destination_city',
          'delivered',
          'signed_by',
          'shipping_fee',
        ],
        properties: {
          tracking_number: { type: 'string' },
          origin_city: { type: 'string' },
          transit_cities: { type: 'array', items: { type: 'string' } },
          destination_city: { type: 'string' },
          delivered: { type: 'boolean' },
          signed_by: { type: 'string' },
          shipping_fee: { type: 'number' },
        },
        additionalProperties: false,
      },
      'logistics',
    ),
    extraction(
      6,
      '本次发布会共发布三款产品：Alpha 手机，起售价 3999 元；Beta 手表，起售价 1299 元；Gamma 耳机，起售价 599 元。',
      '输出一个对象，含且仅含一个字段 products：数组，每个元素是一个对象，含字段 name（字符串）与 price（数字）。数组长度必须为 3。',
      {
        type: 'object',
        required: ['products'],
        properties: {
          products: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              required: ['name', 'price'],
              properties: { name: { type: 'string' }, price: { type: 'number' } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      'nested',
    ),
    extraction(
      7,
      '用户反馈：登录接口在 2025-02-14 09:12 开始出现 500 错误，持续约 18 分钟，影响约 240 名用户，严重等级为「高」，已于 09:30 修复。',
      '- title：字符串\n- severity：字符串，取值仅可为 "低"、"中"、"高"\n- started_at：字符串\n- duration_minutes：整数\n- affected_users：整数\n- resolved：布尔值',
      {
        type: 'object',
        required: ['title', 'severity', 'started_at', 'duration_minutes', 'affected_users', 'resolved'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['低', '中', '高'] },
          started_at: { type: 'string' },
          duration_minutes: { type: 'integer' },
          affected_users: { type: 'integer' },
          resolved: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      'incident',
    ),
    extraction(
      8,
      '论文《Sparse Attention Revisited》由 Chen、Liu 与 Tanaka 合著，2024 年发表于 NeurIPS，共 12 页，引用数 37。',
      '- title：字符串\n- authors：字符串数组\n- year：整数\n- venue：字符串\n- pages：整数\n- citation_count：整数',
      {
        type: 'object',
        required: ['title', 'authors', 'year', 'venue', 'pages', 'citation_count'],
        properties: {
          title: { type: 'string' },
          authors: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
          year: { type: 'integer' },
          venue: { type: 'string' },
          pages: { type: 'integer' },
          citation_count: { type: 'integer' },
        },
        additionalProperties: false,
      },
      'paper',
    ),
  ],
};

/* -------------------------------------------------------------------------- */
/* 2. regex — instruction / format adherence                                   */
/* -------------------------------------------------------------------------- */

function formatTask(
  n: number,
  instruction: string,
  patterns: string[],
  category: string,
  opts: { mode?: 'all' | 'any'; caseSensitive?: boolean } = {},
): QualitySample {
  return {
    id: `format#${n}`,
    input: `${instruction}\n\n${NO_EXPLANATION}`,
    expected: patterns.join(' && '),
    grader: 'regex',
    graderConfig: {
      patterns,
      mode: opts.mode ?? 'all',
      caseSensitive: opts.caseSensitive ?? true,
    },
    category,
  };
}

const instructionFormat: QualityDatasetSeed = {
  slug: 'instruction-format',
  name: '指令格式遵循',
  description: '只考核输出格式与约束是否被严格遵守，不考核内容质量。每条约束都用正则硬判。',
  tags: ['instruction-following', 'format', 'zh'],
  note: '本数据集由 uni-llm-bench 自建。判分只针对格式约束（正则硬判），因此结论不受模型知识与文风影响。',
  samples: [
    formatTask(1, '把下面这句话转成全部大写后输出：hello world from uni llm bench', ['^[A-Z ]+$'], 'casing', {
      caseSensitive: true,
    }),
    formatTask(2, '输出恰好三行内容，每行以「- 」开头，每行至少写一个汉字。主题不限。', [
      '^- .*\\n- .*\\n- .*$',
    ], 'line-structure'),
    formatTask(3, '输出一个 JSON 数组，数组中恰好包含三个字符串元素。', [
      '^\\[\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*\\]$',
    ], 'json-shape'),
    formatTask(4, '输出一行，以 ANSWER: 开头，后面跟一个阿拉伯数字，不要有其他字符。', ['^ANSWER: \\d+$'], 'prefix'),
    formatTask(5, '用 10 个以内的汉字回答：今天天气如何？（任选一种天气作答）', ['^[\\u4e00-\\u9fa5]{1,10}$'], 'length-limit'),
    formatTask(6, '输出一个日期，格式严格为 YYYY-MM-DD，取 2025 年的任意一天。', ['^\\d{4}-\\d{2}-\\d{2}$'], 'date-format'),
    formatTask(7, '输出一个不带任何千分位分隔符、不含正负号和小数点的整数。', ['^\\d+$'], 'number-format'),
    formatTask(8, '输出两行 CSV，每行两列，列之间用英文逗号分隔，不要有表头。', [
      '^[^,\\n]+,[^,\\n]+\\n[^,\\n]+,[^,\\n]+$',
    ], 'csv-shape'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 3. exact — extraction then normalization                                    */
/* -------------------------------------------------------------------------- */

function normalizeTask(n: number, instruction: string, expected: string, category: string): QualitySample {
  return {
    id: `normalize#${n}`,
    input: `${instruction}\n\n${NO_EXPLANATION}`,
    expected,
    grader: 'exact',
    graderConfig: { caseSensitive: false, trimWhitespace: true },
    category,
  };
}

const fieldNormalization: QualityDatasetSeed = {
  slug: 'field-normalization',
  name: '字段抽取与规范化',
  description: '按指定规则把文本中的字段规范化后输出，答案唯一可校验。',
  tags: ['extraction', 'normalization', 'zh'],
  note: '本数据集由 uni-llm-bench 自建。每个答案都能由题面唯一推导，判分采用归一化后的完全匹配。',
  samples: [
    normalizeTask(1, '把「2025 年 3 月 7 日」转成 YYYY-MM-DD 格式输出。', '2025-03-07', 'date'),
    normalizeTask(2, '把「二零二四年十二月三十一日」转成 YYYY-MM-DD 格式输出。', '2024-12-31', 'date'),
    normalizeTask(3, '把手机号「138 0013 8000」去掉所有空格和非数字字符后输出。', '13800138000', 'phone'),
    normalizeTask(4, '把金额「￥ 1,234.50」去掉货币符号和千分位分隔符，只输出数字。', '1234.50', 'amount'),
    normalizeTask(5, '把「晚上 8 点 30 分」转成 24 小时制的 HH:MM 格式输出。', '20:30', 'time'),
    normalizeTask(6, '把「北京市海淀区中关村大街 1 号」中的省级行政区名称去掉后输出。', '海淀区中关村大街 1 号', 'address'),
    normalizeTask(7, '把百分比「百分之三十七点五」转成阿拉伯数字加百分号的形式输出。', '37.5%', 'percentage'),
    normalizeTask(8, '把英文名「john  smith」规范化为「首字母大写、姓首字母大写」的形式（名在前、姓在后），空格只保留一个。', 'John Smith', 'name'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 4. set_match — enumeration from a closed text                               */
/* -------------------------------------------------------------------------- */

function setTask(n: number, instruction: string, expected: string, category: string): QualitySample {
  return {
    id: `set#${n}`,
    input: `${instruction}\n\n${NO_EXPLANATION}多个结果之间用英文逗号分隔。`,
    expected,
    grader: 'set_match',
    graderConfig: { delimiter: ',', setMode: 'exact', caseSensitive: false, trimWhitespace: true },
    category,
  };
}

const setEnumeration: QualityDatasetSeed = {
  slug: 'set-enumeration',
  name: '集合枚举与去重',
  description: '从给定文本中枚举出全部符合条件的目标，多一个、少一个都算错。',
  tags: ['extraction', 'recall', 'zh'],
  note: '本数据集由 uni-llm-bench 自建。正确答案集合由题面文本唯一确定，判分按集合完全相等，因此能同时考核漏报与多报。',
  samples: [
    setTask(
      1,
      '从下面这段文本中列出所有城市名。\n\n文本：本次行程从杭州出发，经南京、武汉，最终抵达成都，返程时在西安短暂停留。',
      '杭州,南京,武汉,成都,西安',
      'cities',
    ),
    setTask(
      2,
      '从下面这段文本中列出所有被提及的编程语言。\n\n文本：该项目后端使用 Python 与 Go，前端使用 TypeScript，脚本工具则用 Bash 编写，早期版本还用过 Ruby。',
      'Python,Go,TypeScript,Bash,Ruby',
      'languages',
    ),
    setTask(
      3,
      '从下面这段文本中列出所有邮箱地址。\n\n文本：请联系 zhang@example.com 或 li@corp.cn；若紧急，可抄送 wang@test.org。',
      'zhang@example.com,li@corp.cn,wang@test.org',
      'emails',
    ),
    setTask(
      4,
      '从下面这段文本中列出所有出现过的错误码。\n\n文本：日志中依次出现 400、429、429、500、503 五种记录，其中 429 重复出现。',
      '400,429,500,503',
      'error-codes',
    ),
    setTask(
      5,
      '从下面这段文本中列出所有产品名称。\n\n文本：本季度主推 Alpha 与 Beta 两款产品；Gamma 已停产，Delta 尚在立项，不在本次推广范围内。',
      'Alpha,Beta',
      'products',
    ),
    setTask(
      6,
      '从下面这段文本中列出所有省份名称。\n\n文本：样本来自广东、浙江、江苏、广东四地的门店，另有少量来自四川与福建。',
      '广东,浙江,江苏,四川,福建',
      'provinces',
    ),
  ],
};

export const OBJECTIVE_TASK_SEEDS: QualityDatasetSeed[] = [
  structuredExtraction,
  instructionFormat,
  fieldNormalization,
  setEnumeration,
];
