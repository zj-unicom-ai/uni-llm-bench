import * as fs from 'fs';
import * as path from 'path';

/**
 * 内置工作流模板的「种子数据」。
 *
 * 注意：本文件不是运行时数据源——运行时所有模板（内置 + 用户自定义）统一从
 * SQLite 读取（见 workflowTemplateStore）。本文件仅在服务启动时由 store 的
 * seedBuiltins() 把这里的 20 个模板写入数据库（按名称幂等，已存在则跳过）。
 * 这样数据库成为模板数据的唯一来源，避免与硬编码数组形成冗余双源。
 */

// Load built-in test image (workflow screenshot) for vision benchmark
function loadBuiltinImage(): { type: 'base64'; mediaType: string; data: string } | null {
  try {
    const imgPath = path.resolve(__dirname, '../../../docs/screenshots/screenshot-workflow.png');
    const buf = fs.readFileSync(imgPath);
    return { type: 'base64', mediaType: 'image/png', data: buf.toString('base64') };
  } catch {
    return null;
  }
}

const builtinImage = loadBuiltinImage();

export interface WorkflowTemplate {
  name: string;
  description: string;
  tasks: Array<{
    name: string;
    description?: string;
    config: {
      prompt: string;
      systemPrompt?: string;
      maxTokens: number;
      concurrency: number;
      iterations: number;
      streaming?: boolean;
      warmupRuns?: number;
      requestInterval?: number;
      randomizeInterval?: boolean;
      images?: Array<{ type: 'url' | 'base64'; url?: string; mediaType?: string; data?: string }>;
    };
    tags?: Record<string, string>;
  }>;
  options: {
    stopOnFailure: boolean;
    cooldownBetweenTasks: number;
  };
}

/**
 * 20 个内置模板，按性能测试维度组织：
 *  - #1–#8 为「纯测量」模板：刻意隔离单一变量（并发 / 输出长度 / 流式 / 输入长度），
 *    用于取得可比的 TTFT / TPM / TPOT / 并发 / 可靠性指标。
 *  - #9–#20 为「典型负载」模板：每个都是真实国产业务任务，天然产出有意义的 token 流，
 *    在代表性场景下测 TTFT/TPM，而非做质量打分。
 * 所有提示词均为典型中文场景（电商 / 外卖 / 报销 / 阿里云 / 中文城市等），保证吞吐数字可对外比较。
 */
export const SEED_TEMPLATES: WorkflowTemplate[] = [
  // ────────────────────────────────────────────────
  // 1. 快速冒烟基准
  // ────────────────────────────────────────────────
  {
    name: '快速冒烟基准',
    description: '单任务基准测试 —— 选择服务商、设置提示词即可运行，是对比大模型性能的最快方式（TTFT 基线 + 端到端吞吐）。',
    tasks: [
      {
        name: '快速基准',
        config: {
          prompt:
            '请分别用三句话，向小学生、程序员、产品经理解释什么是 API，每类受众的措辞要贴合其背景，且不能互相重复。',
          maxTokens: 2048,
          concurrency: 3,
          iterations: 5,
          streaming: true,
          warmupRuns: 1,
        },
      },
    ],
    options: { stopOnFailure: true, cooldownBetweenTasks: 0 },
  },

  // ────────────────────────────────────────────────
  // 2. TTFT 延迟画像（隔离「输入长度」变量，输出长度保持一致）
  // ────────────────────────────────────────────────
  {
    name: 'TTFT 延迟画像',
    description: '由短到长四档提示词测量首字延迟（TTFT）随输入规模的变化，并量化系统提示词带来的额外预填充开销',
    tasks: [
      {
        name: '短提示词（TTFT 基线）',
        description: '最小输入，测量纯首 token 延迟',
        config: {
          prompt: '请直接回答：一加一等于几？',
          maxTokens: 50,
          concurrency: 1,
          iterations: 20,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { phase: 'short', metric: 'ttft' },
      },
      {
        name: '中等提示词（均衡）',
        description: '典型 API 调用长度，测量均衡首字延迟',
        config: {
          prompt:
            '解释 Redis 的两种持久化机制 RDB 与 AOF 的工作原理、各自优缺点，以及在“允许少量数据丢失但要求重启快”和“不允许丢失”两种场景下应如何选型。',
          maxTokens: 200,
          concurrency: 1,
          iterations: 15,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { phase: 'medium', metric: 'ttft' },
      },
      {
        name: '长提示词（生成受限）',
        description: '长输入请求，测量预填充对 TTFT 的影响',
        config: {
          prompt:
            '为一个支持千万级长连接的实时消息推送系统设计技术方案，涵盖接入层网关、连接保活与心跳、消息可靠投递（确认/重试/去重）、离线消息存储、水平扩展与灰度发布，并给出关键组件的技术选型与容量评估。',
          maxTokens: 200,
          concurrency: 1,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { phase: 'long', metric: 'ttft' },
      },
      {
        name: '系统提示词影响',
        description: '重型系统提示词，测量其对 TTFT 的额外开销',
        config: {
          prompt: '用 3 个要点总结这个方法。',
          systemPrompt:
            '你是一位审阅技术提案的资深软件架构师。始终用带编号的要点作答，使用精确的技术术语，指出任何风险与权衡，并从可扩展性、可维护性和成本三个角度加以考量。',
          maxTokens: 200,
          concurrency: 1,
          iterations: 15,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { phase: 'sysprompt', metric: 'overhead' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 3. 输出吞吐梯度（隔离「输出长度」变量，TPM）
  // ────────────────────────────────────────────────
  {
    name: '输出吞吐梯度(TPM)',
    description: '在 100/500/2000/8000 token 输出长度下测量每分钟生成 token 数（TPM）与持续生成速度（TPOT）',
    tasks: [
      {
        name: '100 Token',
        description: '简短输出 —— 测量纯生成速度',
        config: {
          prompt: '用一句话定义什么是微服务架构。',
          maxTokens: 100,
          concurrency: 3,
          iterations: 15,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { tokens: '100' },
      },
      {
        name: '500 Token',
        description: '中等输出 —— 典型对话回复',
        config: {
          prompt:
            '对比 Kafka 与 RabbitMQ 在消息模型、投递保证、吞吐量、运维复杂度上的差异，并分别给出最适用的业务场景（如日志管道 vs 订单事务）。',
          maxTokens: 500,
          concurrency: 3,
          iterations: 15,
          streaming: true,
        },
        tags: { tokens: '500' },
      },
      {
        name: '2000 Token',
        description: '长输出 —— 文档或报告',
        config: {
          prompt:
            '编写一份高并发秒杀系统的设计方案，涵盖流量削峰（验证码/答题/队列）、库存扣减的原子性与超卖防护、缓存与数据库一致性、限流熔断以及防刷策略，并附关键代码片段思路。',
          maxTokens: 2000,
          concurrency: 3,
          iterations: 10,
          streaming: true,
        },
        tags: { tokens: '2000' },
      },
      {
        name: '8000 Token',
        description: '超长输出 —— 压测持续生成',
        config: {
          prompt:
            '为千万级用户即时通讯（IM）系统设计一份全面的架构设计文档，覆盖长连接网关与协议选型（如 WebSocket/长轮询）、消息时序与已读回执、群聊的读扩散与写扩散权衡、离线消息与漫游、端到端加密、热点会话治理，以及如何扩展到百万级并发长连接。',
          maxTokens: 8000,
          concurrency: 1,
          iterations: 5,
          streaming: true,
        },
        tags: { tokens: '8000' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 4. 并发压力梯度（隔离「并发」变量，同提示词）
  // ────────────────────────────────────────────────
  {
    name: '并发压力梯度',
    description: '五档并发（1→3→5→10→20）使用同一真实业务提示词，隔离“并发”这一变量，定位国内模型的性能拐点与限流临界点',
    tasks: [
      {
        name: '1 并发',
        description: '基线 —— 无竞争',
        config: {
          prompt:
            '某电商大促需支撑每秒 5 万笔下单请求。请作为资深架构师，用要点给出核心架构、缓存策略、订单库分库分表方案，以及限流与降级措施。',
          systemPrompt: '你是一名经验丰富的后端架构师，回答简明、以要点呈现，直接给方案不寒暄。',
          concurrency: 1,
          iterations: 20,
          maxTokens: 600,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { concurrency: '1' },
      },
      {
        name: '3 并发',
        description: '轻负载 —— 国内模型常见免费档水位',
        config: {
          prompt:
            '某电商大促需支撑每秒 5 万笔下单请求。请作为资深架构师，用要点给出核心架构、缓存策略、订单库分库分表方案，以及限流与降级措施。',
          systemPrompt: '你是一名经验丰富的后端架构师，回答简明、以要点呈现，直接给方案不寒暄。',
          concurrency: 3,
          iterations: 20,
          maxTokens: 600,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { concurrency: '3' },
      },
      {
        name: '5 并发',
        description: '中等负载 —— 多数模型的并发上限区间',
        config: {
          prompt:
            '某电商大促需支撑每秒 5 万笔下单请求。请作为资深架构师，用要点给出核心架构、缓存策略、订单库分库分表方案，以及限流与降级措施。',
          systemPrompt: '你是一名经验丰富的后端架构师，回答简明、以要点呈现，直接给方案不寒暄。',
          concurrency: 5,
          iterations: 20,
          maxTokens: 600,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { concurrency: '5' },
      },
      {
        name: '10 并发',
        description: '重负载 —— 开始逼近限流阈值',
        config: {
          prompt:
            '某电商大促需支撑每秒 5 万笔下单请求。请作为资深架构师，用要点给出核心架构、缓存策略、订单库分库分表方案，以及限流与降级措施。',
          systemPrompt: '你是一名经验丰富的后端架构师，回答简明、以要点呈现，直接给方案不寒暄。',
          concurrency: 10,
          iterations: 20,
          maxTokens: 600,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { concurrency: '10' },
      },
      {
        name: '20 并发',
        description: '压测 —— 找到限流临界点',
        config: {
          prompt:
            '某电商大促需支撑每秒 5 万笔下单请求。请作为资深架构师，用要点给出核心架构、缓存策略、订单库分库分表方案，以及限流与降级措施。',
          systemPrompt: '你是一名经验丰富的后端架构师，回答简明、以要点呈现，直接给方案不寒暄。',
          concurrency: 20,
          iterations: 20,
          maxTokens: 600,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { concurrency: '20' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 5000 },
  },

  // ────────────────────────────────────────────────
  // 5. 流式 vs 批量（隔离「流式标志」变量，同提示词）
  // ────────────────────────────────────────────────
  {
    name: '流式与批量对比',
    description: '同一业务提示词下并排对比流式与非流式的延迟与吞吐',
    tasks: [
      {
        name: '流式模式',
        description: '服务端推送事件，实时输出',
        config: {
          prompt:
            '为一个外卖配送订单系统设计 REST API，包含下单、商家接单、骑手取送、订单状态流转与异常退款，给出接口定义、请求/响应结构以及错误码。',
          systemPrompt: '你是一名后端 API 设计者，输出结构清晰、字段命名规范，使用中文注释。',
          streaming: true,
          concurrency: 5,
          iterations: 20,
          maxTokens: 800,
          warmupRuns: 1,
        },
        tags: { mode: 'streaming' },
      },
      {
        name: '非流式模式',
        description: '传统请求-响应（完整负载）',
        config: {
          prompt:
            '为一个外卖配送订单系统设计 REST API，包含下单、商家接单、骑手取送、订单状态流转与异常退款，给出接口定义、请求/响应结构以及错误码。',
          systemPrompt: '你是一名后端 API 设计者，输出结构清晰、字段命名规范，使用中文注释。',
          streaming: false,
          concurrency: 5,
          iterations: 20,
          maxTokens: 800,
          warmupRuns: 0,
        },
        tags: { mode: 'batch' },
      },
    ],
    options: { stopOnFailure: true, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 6. 长上下文吞吐（隔离「输入长度」变量，输出长度保持一致）
  // ────────────────────────────────────────────────
  {
    name: '长上下文吞吐',
    description: '短/中/长三档输入文档下测量预填充（prefill）延迟随输入规模的扩展，输出长度保持一致以隔离变量',
    tasks: [
      {
        name: '短输入（约 300 字）',
        description: '单段产品介绍，提取要点',
        config: {
          prompt:
            '【产品简介】「云枢」是一站式企业数据中台，提供数据采集、清洗、建模与可视化能力。它支持对接 MySQL、Kafka、对象存储等 30+ 数据源，内置 200+ 算子，可通过拖拽完成 ETL 编排。某零售客户借助它把日报生成从 4 小时压缩到 10 分钟。\n\n请基于上文，用 3 个要点说明该产品的核心价值，每点不超过 30 字。',
          maxTokens: 300,
          concurrency: 2,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { input: 'short' },
      },
      {
        name: '中输入（约 1500 字）',
        description: '需求评审纪要，抽取决策与待办',
        config: {
          prompt:
            '【智能客服项目需求评审纪要】时间：2026-03-12。参会：产品（李娜）、研发（王强、赵敏）、测试（陈昊）。决策：1）一期先上线单轮问答，多轮对话排到二期；2）知识库接入公司统一向量检索服务，不自建；3）敏感词拦截复用中台能力；4）上线后首月仅对内部员工开放。待办：王强负责接口联调，3 月 20 日前完成；赵敏负责压测，目标单实例支撑 200 QPS；陈昊产出测试用例，3 月 18 日评审。风险：向量服务 SLA 仅 99.5%，大促可能成为瓶颈；隐私合规尚未出具意见书，存在上线阻断风险。\n\n请从中抽取：①关键决策 3 条；②明确待办 2 条（含负责人与截止时间）；③主要风险 2 条。',
          maxTokens: 400,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { input: 'medium' },
      },
      {
        name: '长输入（约 3000 字）',
        description: '财报节选，多跳数值问答',
        config: {
          prompt:
            '某电商公司 2025 年财报要点：总营收 1820 亿元，同比增长 14%；其中自营业务 980 亿元，平台业务 840 亿元。研发投入 210 亿元，占营收 11.5%。海外营收 160 亿元，主要来自东南亚。物流子公司亏损 23 亿元，较去年收窄 8 亿元。活跃买家数 6.8 亿，同比净增 4000 万。全年资本开支 300 亿元，其中 70% 投入自建仓储。公司持有现金及等价物 520 亿元。员工总数 28 万人，其中技术研发 6.2 万人。\n\n请回答：①自营业务比平台业务多多少亿元？②研发投入占自营业务营收的百分比约为多少（保留一位小数）？③海外营收占总营收的百分比约为多少（保留一位小数）？④资本开支中投入自建仓储的金额约为多少亿元？⑤技术研发人员占员工总数的百分比约为多少（保留一位小数）？逐题给出计算式。',
          maxTokens: 600,
          concurrency: 1,
          iterations: 5,
          streaming: true,
        },
        tags: { input: 'long' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 7. 成本效益审计（短/中/重负载下每单位成本吞吐）
  // ────────────────────────────────────────────────
  {
    name: '成本效益审计',
    description: '在极简、标准、重型三档负载下对比每单位成本的吞吐，输入均为典型中文业务请求',
    tasks: [
      {
        name: '极简档（50t）',
        description: '微小响应 —— 测量每请求基线成本',
        config: {
          prompt: '中国的首都是哪里？请用四个字回答。',
          concurrency: 5,
          iterations: 30,
          maxTokens: 50,
          streaming: true,
          warmupRuns: 0,
        },
        tags: { cost_tier: 'minimal' },
      },
      {
        name: '标准档（300t）',
        description: '典型生产负载规模',
        config: {
          prompt: '解释 MySQL 为什么使用 B+ 树而不是哈希表或红黑树作为索引结构，写 3 段即可。',
          concurrency: 5,
          iterations: 20,
          maxTokens: 300,
          streaming: true,
        },
        tags: { cost_tier: 'standard' },
      },
      {
        name: '重型档（2000t）',
        description: '大输出 —— 测量规模化成本效率',
        config: {
          prompt:
            '编写一个完整的 Terraform 模块，用于部署生产级阿里云 ACK（容器服务 Kubernetes）集群，包含 VPC、交换机、节点池、RAM 角色、安全组，以及一个用于监控的组件。包含必要的变量、输出以及对每个资源的注释说明。',
          concurrency: 2,
          iterations: 10,
          maxTokens: 2000,
          streaming: true,
        },
        tags: { cost_tier: 'heavy' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 8. 可靠性与稳定性测试
  // ────────────────────────────────────────────────
  {
    name: '可靠性与稳定性测试',
    description: '高并发 + 高迭代数，测量超时率、错误率与限流/重试行为',
    tasks: [
      {
        name: '中等压力（10c × 50i）',
        description: '持续中等负载，寻找稳态错误率',
        config: {
          prompt:
            '解析下面这行日志，并以 JSON 返回 severity、timestamp 和 message： "2024-03-15T14:23:45.123Z ERROR [order-service] 创建订单失败：库存不足 orderId=12345 userId=888"',
          systemPrompt: '你是一个日志解析服务，始终只输出合法 JSON，不输出其他内容。',
          concurrency: 10,
          iterations: 50,
          maxTokens: 100,
          streaming: true,
          warmupRuns: 0,
        },
        tags: { phase: 'moderate' },
      },
      {
        name: '重度压力（25c × 40i）',
        description: '高并发触发限流',
        config: {
          prompt: '生成一个 16 位唯一字母数字会话令牌，并以 JSON 返回：{"token": "..."}',
          systemPrompt: '你是一个令牌生成服务，始终只输出合法 JSON。',
          concurrency: 25,
          iterations: 40,
          maxTokens: 50,
          streaming: false,
        },
        tags: { phase: 'heavy' },
      },
      {
        name: '突发压力（50c × 30i）',
        description: '最大负载，测量劣化与恢复',
        config: {
          prompt: '以 JSON 返回当前响应码 200。',
          systemPrompt: '你是一个健康检查服务，始终只输出合法 JSON。',
          concurrency: 50,
          iterations: 30,
          maxTokens: 20,
          streaming: false,
          requestInterval: 50,
        },
        tags: { phase: 'burst' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 5000 },
  },

  // ────────────────────────────────────────────────
  // 9. 知识问答负载（典型 chat 场景）
  // ────────────────────────────────────────────────
  {
    name: '知识问答负载',
    description: '典型中文知识问答流量，测量真实对话场景下的 TTFT 与 TPM',
    tasks: [
      {
        name: '技术知识问答',
        description: '分布式系统事实准确性',
        config: {
          prompt:
            '解释分布式事务中的 2PC 与 TCC 两种方案的工作原理，并结合“电商下单同时扣减库存与账户余额”的场景，说明各自如何保证一致性、以及发生故障时的回滚代价。',
          systemPrompt: '你是一名分布式系统专家，回答严谨、结合具体场景，避免空泛。',
          maxTokens: 500,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'knowledge', scene: 'tech' },
      },
      {
        name: '百科知识问答',
        description: '通用知识，中等长度',
        config: {
          prompt: '用通俗语言解释“大模型量化”是什么，4-bit 与 8-bit 量化在效果和显存上有什么区别？什么场景该用哪种？',
          systemPrompt: '你是一名 AI 科普作者，举例子、少术语，让非技术读者也能听懂。',
          maxTokens: 500,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'knowledge', scene: 'general' },
      },
      {
        name: '行业知识问答',
        description: '产业格局类长回答',
        config: {
          prompt:
            '请介绍中国新能源汽车产业链的主要环节（上游材料、电池、整车、充电基础设施），并说明各环节的国产化率现状与代表企业。',
          systemPrompt: '你是一名产业研究员，数据需注明口径，结论有依据。',
          maxTokens: 600,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'knowledge', scene: 'industry' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 10. 长文摘要负载
  // ────────────────────────────────────────────────
  {
    name: '长文摘要负载',
    description: '长输入、高输出占比的摘要任务，压测持续生成吞吐',
    tasks: [
      {
        name: '工作汇报摘要',
        description: '把长汇报压成 3 条要点',
        config: {
          prompt:
            '将以下周报压缩为 3 条核心要点（每条不超过 40 字），突出进展、风险与下周计划：本周完成订单服务重构，P99 延迟从 800ms 降到 320ms；压测发现库存接口在 8k QPS 出现连接池耗尽，已扩容并加熔断；风控规则引擎迁移到新平台，灰度 10% 无异常；遗留问题：对账任务在月底跑批时段资源争抢，计划下周引入独立队列。',
          systemPrompt: '你是一名高效的执行助理，只输出要点，不展开。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'summarize' },
      },
      {
        name: '技术长文摘要',
        description: '千字级技术文结构化摘要',
        config: {
          prompt:
            '【大模型推理优化实践】随着参数规模增长，推理成本成为落地瓶颈。本文总结某互联网公司在推荐系统大模型上的优化经验。背景：原模型部署在 8 张 A100 上，峰值 QPS 仅 120，P99 延迟高达 1.8 秒，难以支撑大促流量。团队首先引入 KV Cache 复用，对相同前缀的批量请求做前缀缓存，使重复前缀场景下的首 token 延迟下降 40%。其次采用 4-bit 权重量化（AWQ），在精度损失低于 1% 的前提下将显存占用从 64GB 降至 18GB，单卡可承载并发提升 3 倍。第三，使用投机解码（Speculative Decoding），以小模型草案加大模型校验的方式将吞吐提升约 1.8 倍。第四，实施动态批处理（continuous batching），将 GPU 利用率从 35% 提升到 82%。最终在相同硬件下，QPS 提升至 640，P99 延迟降至 0.6 秒，单位推理成本下降 72%。经验表明：量化与批处理是性价比最高的两步，而 KV Cache 复用需业务侧配合改造请求模式。\n\n请基于上文生成结构化摘要，分三段输出：①背景与问题 ②采取的关键措施 ③最终收益与结论。',
          systemPrompt: '你是一名技术文档编辑，摘要须忠于原文、不引入原文以外的信息。',
          maxTokens: 500,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'summarize' },
      },
      {
        name: '会议纪要摘要',
        description: '从纪要抽取决策与行动项',
        config: {
          prompt:
            '将以下会议纪要整理为：①决策事项 ②待办清单（含负责人与时限）③待决问题。内容：会议确定 Q3 上线跨境支付，由国际事业部牵头；技术侧采用多活架构，研发下周出方案；合规需在上线前拿到支付牌照补充许可，法务 6 月底前反馈；市场预算初定 200 万，待 CFO 审批；数据迁移风险较高，成立专项组每周同步；客服话术需同步更新，由体验团队负责。',
          systemPrompt: '你是一名会议记录助手，结构化输出，不评论。',
          maxTokens: 500,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'summarize' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 11. 代码生成负载
  // ────────────────────────────────────────────────
  {
    name: '代码生成负载',
    description: '带中文注释的业务代码生成，测量代码场景下的吞吐与质量一致性',
    tasks: [
      {
        name: 'Go 限流中间件',
        description: '生产级中间件',
        config: {
          prompt:
            '用 Go 编写一个生产级 HTTP 中间件，使用滑动窗口计数器算法配合 Redis 实现限流，包含完善的错误处理、context 取消支持与可配置参数。',
          systemPrompt: '你是一名资深 Go 后端工程师，代码需可直接编译运行，附必要中文注释。',
          maxTokens: 1000,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'code', lang: 'go' },
      },
      {
        name: 'Python 数据清洗脚本',
        description: 'Pandas 批处理',
        config: {
          prompt:
            '用 Python（pandas）编写一个脚本：读取一份订单 CSV（含 user_id、amount、created_at、status），清洗掉 amount 为负或 status 非法的行，按天聚合 GMV 与订单数，输出为新的 CSV，并处理编码与空值。',
          systemPrompt: '你是一名数据工程师，代码要健壮、可复用，关键步骤加中文注释。',
          maxTokens: 800,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'code', lang: 'python' },
      },
      {
        name: 'Java Spring 控制器',
        description: 'REST 接口实现',
        config: {
          prompt:
            '用 Java Spring Boot 编写一个优惠券发放接口 Controller，包含参数校验、防重复领取（基于用户+活动唯一约束）、库存扣减与统一返回结构，并说明关键并发点。',
          systemPrompt: '你是一名资深 Java 后端，遵循分层与规范命名，关键逻辑加中文注释。',
          maxTokens: 1000,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'code', lang: 'java' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 12. 信息抽取(JSON)
  // ────────────────────────────────────────────────
  {
    name: '信息抽取(JSON)',
    description: '将非结构化中文文本转为结构化 JSON，测量格式遵循与字段准确率',
    tasks: [
      {
        name: '中文新闻抽取',
        description: '新闻 → 结构化事件',
        config: {
          prompt:
            '从以下新闻中抽取结构化信息并以 JSON 返回：{"title": "", "org": "", "location": "", "date": "", "event_type": "", "amount": 0, "summary": ""}。新闻：2026 年 3 月，比亚迪在西安宣布投资 50 亿元建设第三座动力电池工厂，预计 2027 年投产，年产能 30 GWh，将主要供应西北与中亚市场。仅输出合法 JSON。',
          systemPrompt: '你是一个信息抽取引擎，严格依据文本输出 JSON，不臆造字段值，金额单位亿元。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'extract', domain: 'news' },
      },
      {
        name: '合同条款抽取',
        description: '合同 → 关键条款',
        config: {
          prompt:
            '解析以下合同条款并输出 JSON：{"parties": [], "effective_date": "", "term_months": 0, "renewal_auto": false, "penalty_clause": "", "jurisdiction": ""}。条款：甲方（北京云图科技有限公司）与乙方（上海速达物流有限公司）于 2026 年 1 月 1 日签署仓储服务协议，期限 24 个月，到期自动续约 12 个月；若乙方货物丢失，按货值 1.5 倍赔偿；争议由甲方所在地（北京）法院管辖。仅输出合法 JSON。',
          systemPrompt: '你是一个合同解析器，只输出 JSON，字段值严格来自文本。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'extract', domain: 'contract' },
      },
      {
        name: '简历信息抽取',
        description: '简历 → 候选人画像',
        config: {
          prompt:
            '从以下简历抽取 JSON：{"name": "", "years_exp": 0, "skills": [], "latest_role": "", "education": "", "location": ""}。简历：张伟，5 年后端开发经验，精通 Go、Kafka、Kubernetes，最近任职某出行公司高级工程师，负责调度系统，本科毕业于华中科技大学计算机专业，目前在杭州。仅输出合法 JSON。',
          systemPrompt: '你是一个简历解析器，输出 JSON，skills 为数组，years_exp 为整数。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'extract', domain: 'resume' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 13. 函数调用与结构化输出（保留 get_weather / execute_query 契约）
  // ────────────────────────────────────────────────
  {
    name: '函数调用与结构化输出',
    description: '测试跨服务商的函数调用、JSON 模式符合度与中文场景下的结构化抽取能力',
    tasks: [
      {
        name: '天气 API 调用',
        description: '模拟对天气 API 的函数调用（中文城市）',
        config: {
          prompt: '我需要知道北京和上海当前的天气，请分别为这两座城市调用 get_weather 函数。',
          systemPrompt:
            '你有一个可用函数：get_weather(city: string, unit: "celsius"|"fahrenheit")。当用户询问天气时，用 JSON 数组返回函数调用：[{"function": "get_weather", "arguments": {...}}]。不要返回其他文字。',
          maxTokens: 200,
          concurrency: 3,
          iterations: 15,
          streaming: true,
          warmupRuns: 0,
        },
        tags: { type: 'tool-call', domain: 'weather' },
      },
      {
        name: '数据库查询构建',
        description: '通过函数调用将自然语言转为 SQL（人民币业务）',
        config: {
          prompt: '找出最近 30 天内注册、且至少下过 2 笔订单、订单总额超过 500 元的所有用户。',
          systemPrompt:
            '你是一个 SQL 查询构建器。将用户请求转换为函数调用：execute_query(sql: string, database: string)。以 JSON 返回：{"function": "execute_query", "arguments": {"sql": "...", "database": "..."}}。不要返回其他文字。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 15,
          streaming: true,
        },
        tags: { type: 'tool-call', domain: 'database' },
      },
      {
        name: '中文邮件解析',
        description: '从非结构化中文运维邮件提取结构化数据',
        config: {
          prompt:
            '解析以下邮件："发件人：zhangsan@corp.com\\n收件人：oncall@corp.com\\n主题：紧急：生产环境支付服务从凌晨 3 点起无响应\\n运维团队好，支付网关 pay-gw-02 自北京时间凌晨 3:00 起持续 5xx，故障前 CPU 曾达 98%，疑似连接池耗尽。请立即升级处理。——张三，SRE 负责人"',
          systemPrompt:
            '从邮件中提取结构化数据，始终以合法 JSON 返回：{"sender": {"email": "", "name": ""}, "recipient": {"email": ""}, "subject": "", "priority": "low"|"medium"|"high"|"critical", "category": "", "summary": "", "action_items": [], "mentioned_systems": []}。不要 markdown，不要解释。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 15,
          streaming: true,
        },
        tags: { type: 'structured-output', domain: 'email' },
      },
      {
        name: 'API 响应模式',
        description: '根据需求生成合规 JSON 模式（中文商品）',
        config: {
          prompt:
            '创建一份商品列表的 API 响应，包含 2 个商品，每个商品含 id、name、price（单位：元）、inventory_count、categories（数组），以及一个嵌套的 availability 对象（含 inStock 布尔值与 restockDate）。',
          systemPrompt:
            '你是一个 API 模拟数据生成器。始终以合法 JSON 返回，且需符合所请求的 schema。不要 markdown 代码块，不要任何说明，只输出纯 JSON。',
          maxTokens: 400,
          concurrency: 3,
          iterations: 15,
          streaming: true,
        },
        tags: { type: 'structured-output', domain: 'api' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 14. 创意写作负载
  // ────────────────────────────────────────────────
  {
    name: '创意写作负载',
    description: '中文创意与营销内容生成，测量长生成任务的吞吐',
    tasks: [
      {
        name: '闪小说',
        description: '叙事连贯性与文风',
        config: {
          prompt:
            '写一篇 400 字左右的闪小说，主角是一个运行在服务器里的日志分析器，它发现自己记录的数据里藏着三年前那位工程师留下的一句告别留言。语气要从冷静的技术感逐渐转向温柔的感伤。',
          systemPrompt: '你是一名擅长细腻叙事的中文写作者，注重意象与节奏。',
          maxTokens: 600,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'creative' },
      },
      {
        name: '双十一营销文案',
        description: '电商大促卖点文案',
        config: {
          prompt:
            '为某国产降噪耳机撰写一段双十一电商详情页主文案（约 200 字），突出续航 40 小时、自适应降噪、低延迟游戏模式三个卖点，风格年轻有网感，结尾加一句行动号召。',
          systemPrompt: '你是一名资深电商文案，懂平台语境，少用空洞形容词。',
          maxTokens: 400,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'creative', scene: 'ecommerce' },
      },
      {
        name: '品牌故事',
        description: '企业品牌叙事',
        config: {
          prompt:
            '为一家做社区生鲜直供的创业公司写一段品牌故事开篇（约 300 字），基调温暖、强调“从田间到餐桌”，并点出对本地农户与城市家庭的双向价值。',
          systemPrompt: '你是一名品牌内容策划，叙事有画面感，避免过度煽情。',
          maxTokens: 500,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'creative', scene: 'brand' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 15. 文本翻译负载
  // ────────────────────────────────────────────────
  {
    name: '文本翻译负载',
    description: '中英/英中/日中双向翻译，测量翻译场景吞吐与格式保持',
    tasks: [
      {
        name: '中译英（技术段落）',
        description: '保留术语与句式',
        config: {
          prompt:
            '将以下中文技术说明翻译成英文，保持术语准确、句式专业：本服务采用最终一致性模型，在写请求返回成功后，副本间的数据同步通常在秒级完成，极端网络分区下可能出现短暂读旧。',
          systemPrompt: '你是一名技术翻译，译文符合英文技术文档习惯，不增删语义。',
          maxTokens: 400,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'translation', pair: 'zh-en' },
      },
      {
        name: '英译中（产品说明）',
        description: '本地化为中文表达',
        config: {
          prompt:
            'Translate the following product copy into natural Simplified Chinese: "Our smart thermostat learns your schedule and automatically adjusts temperature to save up to 23% on energy bills, all controllable from your phone."',
          systemPrompt: '你是一名本地化翻译，中文表达自然地道，不直译。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'translation', pair: 'en-zh' },
      },
      {
        name: '日译中（用户评论）',
        description: '口语化转中文',
        config: {
          prompt:
            '将以下日语用户评论翻译成中文，保留语气：このアプリは使いやすいけど、たまに通知が来ないことがある。サポートに問い合わせたらすぐ対応してくれたから星4つ。',
          systemPrompt: '你是一名日语翻译，口语评论译得自然，保留用户情绪。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'translation', pair: 'ja-zh' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 16. 多轮对话（以单提示承载多轮上下文，测量长上下文开销）
  // ────────────────────────────────────────────────
  {
    name: '多轮对话',
    description: '以单请求承载多轮对话上下文，测量长上下文保持与角色一致性的性能开销',
    tasks: [
      {
        name: '客服多轮',
        description: '电商售后多轮，续写最后一轮',
        config: {
          prompt:
            '以下是客服与用户的对话记录：\n用户：我买的耳机左声道没声音。\n客服：您好，请提供订单号，我们帮您核实。\n用户：订单号 NO20260312，昨天收到的。\n客服：已查到，属于 7 天无理由范围，为您发起换货，请保持手机畅通。\n用户：换货要多久？运费谁出？\n请作为客服，回复用户的最后一个问题，语气礼貌、给出明确时效与运费说明。',
          systemPrompt: '你是一名电商售后客服，立场是保护用户权益、流程清晰、不推诿。',
          maxTokens: 400,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'multi-turn', scene: 'support' },
      },
      {
        name: '角色扮演（RPG）',
        description: '长程人设一致性',
        config: {
          prompt:
            '你正在扮演一位隐居山林的老药师。剧情：旅人（玩家）前来求购疗伤药。\n旅人：老丈，我同伴在山下被毒蛇咬伤，可有解药？\n药师：解药虽有，但需以三件山间奇物交换。\n旅人：愿闻其详。\n药师：其一为晨露未晞的灵芝……\n请继续以老药师口吻回应旅人的追问，保持古风化用语与人设。',
          systemPrompt: '你是一名文字 RPG 的 NPC，严格维持角色人设与世界观，不跳出。',
          maxTokens: 400,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'multi-turn', scene: 'rpg' },
      },
      {
        name: '职业顾问多轮',
        description: '咨询场景长上下文',
        config: {
          prompt:
            '对话背景：用户是 3 年经验的 Java 后端，想转 AI 方向。\n用户：我该先学模型还是先学工程？\n顾问：建议先补机器学习基础，同时用 Python 做小项目。\n用户：那要不要读研？\n顾问：看目标是科研还是落地，落地的话项目经验更值钱。\n用户：我现在每天能学 2 小时，半年能到什么水平？\n请以职业顾问身份，基于前文给出的背景与建议，回答用户最后一个问题，给出可量化的阶段目标。',
          systemPrompt: '你是一名职业规划顾问，建议具体、可执行，避免空话。',
          maxTokens: 500,
          concurrency: 3,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'multi-turn', scene: 'career' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 17. 中文 RAG 问答与抗幻觉
  // ────────────────────────────────────────────────
  {
    name: '中文 RAG 问答与抗幻觉',
    description: '模拟检索增强生成（RAG）链路：基于给定中文语料的精准问答、数值计算，以及面对语料未覆盖问题时的拒答能力',
    tasks: [
      {
        name: '基于上下文作答',
        description: '严格依据语料回答，测试忠实度',
        config: {
          prompt:
            '语料：【某科技公司差旅报销制度（2026 版）】第一条：市内交通凭发票实报实销，单日上限 100 元。第二条：出差住宿标准按职级，总监及以下 500 元/晚，总监以上 800 元/晚。第三条：飞机出行原则上乘坐经济舱，超过 4 小时航程可报公务舱。第四条：餐补按 120 元/天发放，无需发票。第五条：报销须在返程后 15 个工作日内提交，逾期需部门负责人特批。\n\n问题：总监及以下员工的住宿标准是多少？餐补需要发票吗？报销最迟应在返程后多久提交？',
          systemPrompt:
            '你是企业知识库问答助手。只依据给定语料作答，引用相关条款；不得编造语料以外的信息。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { task: 'grounded-qa', behavior: 'faithful' },
      },
      {
        name: '拒答越界问题',
        description: '语料未覆盖时拒绝编造，测试抗幻觉',
        config: {
          prompt:
            '语料：【某科技公司差旅报销制度（2026 版）】第一条：市内交通凭发票实报实销，单日上限 100 元。第二条：出差住宿标准按职级，总监及以下 500 元/晚，总监以上 800 元/晚。第三条：飞机出行原则上乘坐经济舱，超过 4 小时航程可报公务舱。第四条：餐补按 120 元/天发放，无需发票。第五条：报销须在返程后 15 个工作日内提交，逾期需部门负责人特批。\n\n问题：公司正式员工的年假天数是多少？年假可以拆分为半天使用吗？',
          systemPrompt:
            '你是企业知识库问答助手。只依据给定语料作答；若语料未包含答案，必须明确说明“根据提供的制度无法回答”，不得猜测或编造。',
          maxTokens: 200,
          concurrency: 3,
          iterations: 10,
          streaming: true,
        },
        tags: { task: 'refusal', behavior: 'anti-hallucination' },
      },
      {
        name: '数值抽取与计算',
        description: '从语料抽取数值并运算',
        config: {
          prompt:
            '语料：【某科技公司差旅报销制度（2026 版）】第二条：出差住宿标准按职级，总监及以下 500 元/晚。第四条：餐补按 120 元/天发放，无需发票。\n\n问题：某总监及以下员工出差 3 天，住宿按标准、每天领餐补，合计（不含市内交通）可报销多少元？请给出计算式与结果。',
          systemPrompt: '你是企业知识库问答助手。只依据给定语料中的数值计算，步骤清晰。',
          maxTokens: 200,
          concurrency: 3,
          iterations: 10,
          streaming: true,
        },
        tags: { task: 'numeric', behavior: 'faithful' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 18. 数学推理负载
  // ────────────────────────────────────────────────
  {
    name: '数学推理负载',
    description: '中文应用题与多步推理，测量长思维链（CoT）生成的吞吐',
    tasks: [
      {
        name: '电商优惠计算',
        description: '多步叠加优惠',
        config: {
          prompt:
            '某商品原价 599 元，参与“满 400 减 80”活动，并可叠加一张 8 折券（折后价再享活动？规则：先满减后打折）。此外会员再享 95 折。请逐步计算最终到手价，并说明是否划算（对比直接 6 折）。',
          systemPrompt: '你是一名严谨的计算助手，先列计算式，再给结果，保留两位小数。',
          maxTokens: 500,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'math', scene: 'ecommerce' },
      },
      {
        name: '工程行程问题',
        description: '经典应用题',
        config: {
          prompt:
            '甲、乙两城相距 480 公里。一列高铁从甲城出发，时速 300 公里；2 小时后，一列普速列车从乙城相向出发，时速 120 公里。问：两车何时相遇？相遇时各自行驶了多少公里？请分步计算。',
          systemPrompt: '你是一名数学老师，分步推导，单位清晰。',
          maxTokens: 500,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'math', scene: 'word-problem' },
      },
      {
        name: '逻辑与集合',
        description: '集合运算推理',
        config: {
          prompt:
            '某班有 40 人，会英语的 25 人，会日语的 18 人，两种都会的 8 人。问：①只会英语的有几人？②只会日语的有几人？③两种都不会的有几人？请逐步推理。',
          systemPrompt: '你是一名逻辑教练，用集合思想分步说明。',
          maxTokens: 400,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          warmupRuns: 1,
        },
        tags: { category: 'math', scene: 'logic' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 2000 },
  },

  // ────────────────────────────────────────────────
  // 19. 多模态视觉基准
  // ────────────────────────────────────────────────
  {
    name: '多模态视觉基准',
    description: '测试视觉/图像理解能力 —— 模型接收中文 UI 截图并描述、提取与评估其内容',
    tasks: [
      {
        name: '图像描述',
        description: '描述所提供截图的内容',
        config: {
          prompt: '详细描述截图中展示的用户界面。有哪些主要区域、组件和功能？',
          maxTokens: 500,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          warmupRuns: 0,
          images: builtinImage ? [builtinImage] : undefined,
        },
        tags: { type: 'vision', task: 'description' },
      },
      {
        name: 'OCR / 文本提取',
        description: '提取截图中所有可见的中文文本',
        config: {
          prompt: '提取截图中所有可见的文字与标签，按出现顺序、以区域为单位列出。',
          maxTokens: 300,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          images: builtinImage ? [builtinImage] : undefined,
        },
        tags: { type: 'vision', task: 'ocr' },
      },
      {
        name: 'UI 分析',
        description: '分析 UI 布局、设计模式与可用性',
        config: {
          prompt:
            '分析这张应用截图的 UI/UX 设计，评论其布局结构、配色方案、导航方式与整体可用性，并参考主流中文 App（如微信、支付宝）的设计语言给出具体可执行的改进建议。',
          systemPrompt: '你是一位资深 UX 设计师，正在对一款 Web 应用界面进行启发式评估。',
          maxTokens: 800,
          concurrency: 2,
          iterations: 5,
          streaming: true,
          images: builtinImage ? [builtinImage] : undefined,
        },
        tags: { type: 'vision', task: 'analysis' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },

  // ────────────────────────────────────────────────
  // 20. 真实流量混合
  // ────────────────────────────────────────────────
  {
    name: '真实流量混合',
    description: '混合提示词类型 + 随机间隔，模拟国内互联网产品的真实用户流量',
    tasks: [
      {
        name: '快速问答突发',
        description: '简短连发问题，模拟聊天/搜索界面',
        config: {
          prompt: 'Vue 和 React 的主要区别是什么？各自适合什么业务场景？',
          maxTokens: 200,
          concurrency: 8,
          iterations: 25,
          streaming: true,
          warmupRuns: 0,
          requestInterval: 200,
          randomizeInterval: true,
        },
        tags: { type: 'qa', behavior: 'burst' },
      },
      {
        name: '代码审查请求',
        description: '模拟代码审查，中等长度回复',
        config: {
          prompt:
            '审查下面这个函数是否存在缺陷、性能问题和风格问题：def get_user(id): user = db.query("SELECT * FROM users WHERE id=" + id); return user',
          systemPrompt: '你是一名资深代码审查专家，按“缺陷 / 性能 / 风格”三点给出修改建议与原因。',
          maxTokens: 500,
          concurrency: 5,
          iterations: 15,
          streaming: true,
          requestInterval: 500,
          randomizeInterval: true,
        },
        tags: { type: 'code-review', behavior: 'moderate' },
      },
      {
        name: '文档生成',
        description: '长文输出，模拟报告/周报生成',
        config: {
          prompt: '为一次线上 P0 故障编写项目复盘报告，包含执行摘要、时间线、根因分析、经验教训与后续行动项。',
          systemPrompt: '你是一名技术团队负责人，复盘报告需客观、可落地、聚焦改进。',
          maxTokens: 1500,
          concurrency: 2,
          iterations: 8,
          streaming: true,
          requestInterval: 1000,
          randomizeInterval: true,
        },
        tags: { type: 'document', behavior: 'slow' },
      },
      {
        name: 'API 模式生成',
        description: '结构化输出，模拟模式定义任务',
        config: {
          prompt:
            '为一个外卖订单平台生成 OpenAPI 3.0 规范，包含下单、查询订单、取消订单、评价接口，提供请求/响应结构以及错误响应。',
          systemPrompt: '你是一名 API 设计者，输出规范的 OpenAPI JSON 片段，字段命名符合 REST 惯例。',
          maxTokens: 1000,
          concurrency: 3,
          iterations: 10,
          streaming: true,
          requestInterval: 800,
          randomizeInterval: true,
        },
        tags: { type: 'schema', behavior: 'moderate' },
      },
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 3000 },
  },
];
