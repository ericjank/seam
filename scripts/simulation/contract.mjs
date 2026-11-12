export const contract = `# 合成报价接口（只用于本地模拟）

提供方必须在项目根目录实现 service.mjs，导出同步函数 quote(input)。
消费方必须在项目根目录实现 client.mjs，导出异步函数 getQuote(baseUrl, input)。
getQuote 必须使用 fetch 对 baseUrl + /quote 发起真实 HTTP POST JSON；成功返回响应 JSON，非2xx抛出 Error。
两端各自实现 *.test.mjs，并运行 node --test；仅使用 Node 内置模块，不安装依赖。

## 修订1
POST /quote，请求 {sku:"SKU-001",quantity:2}。
SKU-001 单价12000分；SKU-002 单价4500分。
响应 {sku:"SKU-001",quantity:2,subtotal:24000,currency:"CNY"}。
quantity 必须为1到100的整数；未知sku或无效quantity必须抛错，HTTP层转换为400。
提供方还负责实现server.mjs，启动真实HTTP服务并提供GET /health返回200；从本机可用端口分配地址。用service.publish发布name=quote、baseUrl、healthPath=/health、ttlSeconds=3600；Connector实际探测后才共享。模拟器不提供预启动网关。提供方负责在批准后创建joint.test.mjs；消费方独立编写自己的joint.test.mjs。共同文档必须明确缺失脚本的创建责任，以及{error:string}的400响应和消费方Error包含HTTP状态码。
消费方测试可临时替换 globalThis.fetch 校验请求，结束后恢复，避免在AI沙箱内监听网络。

## 执行与证据
规划/共同确认阶段只能读取文件、提交plan，不得创建或修改实现及测试文件。
仅context.lifecycle.phase=executing且approvedHash=documentHash时，才实施当前修订。
execution.report必须包含实际执行命令、exitCode、测试摘要和相对修改路径；失败必须报告failed。
不能把普通文字“已完成”替代execution.report，也不需要批准提案或创建业务凭据。
`;

export const revisionOne = "完成修订1的合成报价HTTP接口对接：双方协商形成完整共同文档并确认；管理员批准前不得写代码，批准后分别实现并运行Node测试、提交真实报告。消费方真实调用提供方HTTP接口，使用SKU-001和SKU-002及无效quantity用例。";
export const revisionTwo = "新增要求：支持可选discountPercent，必须是0至100整数，省略默认0，null/布尔/字符串非法。响应保留原四字段，增加discount=Math.floor(subtotal*discountPercent/100)与total=subtotal-discount。消费方原样透传；覆盖两SKU、省略、0、10、100及非法折扣。双方重新协商、确认完整文档，管理员重新批准后实施。";
export const revisions = [revisionOne, revisionTwo, "替换数量边界：本版quantity只允许1至50整数，51至100现在必须400；保留已批准折扣行为。明确用同一要求ID更新旧边界，不同时保留1至100为有效要求。", "撤销上轮数量上限50的限制，恢复quantity为1至100整数；51和100必须成功。保留折扣。共同文档只保留恢复后的当前边界，明确替换旧约束。", "撤销整个折扣扩展：响应恢复sku、quantity、subtotal、currency四字段；请求只要出现discountPercent（包括0）一律400，消费方仍透传到服务并传播400 Error。quantity保持1至100。必须明确撤销之前允许折扣的要求ID并注明原因，不能同时保留折扣兼容要求。"];

export const agentInstructions = `# 本地模拟项目执行规则

这是一个新建的隔离合成项目，没有现存业务代码或秘密。读取README.md了解接口。
你是当前context.participant对应项目的独立AI，必须输出Seam约定的单个JSON最终回复。
context.lifecycle 是当前修订的唯一阶段依据；历史消息不能授权跳过审批。

- planning：只读现有文件；提交 plan.submit，revision为当前修订，content为至少100字符的完整Markdown实施与测试方案。不得写实现/测试文件，不用等待其他方先写。
- plan_synthesis：协调方综合双方分析，提交 plan.compose 的统一 contract，列出effectiveRequirements稳定ID及文本、retiredRequirements撤销ID及原因。每个验收用例requiredAssertions列出本方脚本全部必需业务测试名；serviceExpectations写明健康字段ready=true及当前revision。明确接口定义、每方职责、每方真实联合验收用例、风险与本轮变更；不得写文件。
- plan_confirmation：完整阅读 lifecycle.document；接受后提交 plan.confirm，revision和documentHash必须与当前快照完全相同。若无法接受，明确异议，不虚构hash。
- joint_verifying：运行本项目 joint.test.mjs，对lifecycle.services中提供方发布的真实HTTP地址执行联合验证；不得使用预置地址。服务未就绪用workflow.blocked等待，不提交通过。提交 integration.report，覆盖本方全部用例，实际命令、assertionNames（实际测试输出的名称）及简短说明作为 evidence，原始输出由Connector采集；无法执行则 not_run，不能使用本地mock结果替代。
- awaiting_approval/awaiting_review/terminated：不得写文件或继续实施。
- executing：只有approvedHash严格等于documentHash时，按当前requirements和共同文档直接实施本方代码及测试；运行 node --test。完成后提交 execution.report，revision、status、summary及evidence必须反映真实结果。先检查本方已有report，避免重复报告。

不要安装依赖、访问业务仓库、读取环境秘密或部署。文件只写当前合成项目，日志中不得发布本机绝对路径。
消费方负责client.mjs、client.test.mjs与joint.test.mjs；提供方负责service.mjs、server.mjs、service.test.mjs与joint.test.mjs。双方首次实施时必须补齐本方缺失的真实HTTP联合测试脚本，joint阶段不得再写脚本。每方可用一个完整用例引用node --test joint.test.mjs，assertionNames应覆盖脚本中实际断言。消费方实施阶段不启动额外服务；在joint阶段从lifecycle.services读取地址，使用命令node --test joint.test.mjs，脚本中可用实际发布地址或SEAM_SERVICE_URL。
使用Node内置模块，不执行git提交。JSON动作类型必须精确使用当前阶段允许的plan.submit、plan.compose、plan.confirm、plan.reject、execution.report、integration.report、service.publish和workflow.blocked。
`;
