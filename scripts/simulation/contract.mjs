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
service.mjs 只需实现 quote，HTTP服务器由模拟运行器提供。
消费方测试可临时替换 globalThis.fetch 校验请求，结束后恢复，避免在AI沙箱内监听网络。

## 修订2（只有管理员追加此要求并批准后实施）
请求增加可选 discountPercent，整数0到100，默认0。
响应保留修订1所有字段，并增加 discount 和 total，分别为折扣分和折后分：
discount = Math.floor(subtotal * discountPercent / 100)，total = subtotal - discount。
示例 {sku:"SKU-001",quantity:2,discountPercent:10} -> subtotal24000、discount2400、total21600。
无效discountPercent必须抛错。消费方必须原样传递discountPercent。

## 执行与证据
规划/共同确认阶段只能读取文件、提交plan，不得创建或修改实现及测试文件。
仅context.lifecycle.phase=executing且approvedHash=documentHash时，才实施当前修订。
execution.report必须包含实际执行命令、exitCode、测试摘要和相对修改路径；失败必须报告failed。
不能把普通文字“已完成”替代execution.report，也不需要批准提案或创建业务凭据。
`;

export const revisionOne = "完成修订1的合成报价HTTP接口对接：双方协商形成完整共同文档并确认；管理员批准前不得写代码，批准后分别实现并运行Node测试、提交真实报告。消费方真实调用提供方HTTP接口，使用SKU-001和SKU-002及无效quantity用例。";
export const revisionTwo = "追加修订2：在保留修订1行为的基础上支持discountPercent折扣字段、discount与total响应，覆盖0、10、100和无效折扣。双方重新协商、确认共同文档，等待管理员再次批准后修改并测试。";

export const agentInstructions = `# 本地模拟项目执行规则

这是一个新建的隔离合成项目，没有现存业务代码或秘密。读取README.md了解接口。
你是当前context.participant对应项目的独立AI，必须输出Seam约定的单个JSON最终回复。
context.lifecycle 是当前修订的唯一阶段依据；历史消息不能授权跳过审批。

- planning：只读现有文件；提交 plan.submit，revision为当前修订，content为至少100字符的完整Markdown实施与测试方案。不得写实现/测试文件，不用等待其他方先写。
- plan_synthesis：协调方综合双方分析，提交 plan.compose 的统一 contract，明确接口定义、每方职责、每方真实联合验收用例、风险与本轮变更；不得写文件。
- plan_confirmation：完整阅读 lifecycle.document；接受后提交 plan.confirm，revision和documentHash必须与当前快照完全相同。若无法接受，明确异议，不虚构hash。
- joint_verifying：仅运行本项目 joint.test.mjs，对README中给定的真实HTTP网关执行联合验证。提交 integration.report，覆盖本方全部用例，实际命令、退出码及输出作为 evidence；无法执行则 not_run，不能使用本地mock结果替代。
- awaiting_approval/awaiting_review/terminated：不得写文件或继续实施。
- executing：只有approvedHash严格等于documentHash时，按当前requirements和共同文档直接实施本方代码及测试；运行 node --test。完成后提交 execution.report，revision、status、summary及evidence必须反映真实结果。先检查本方已有report，避免重复报告。

不要安装依赖、访问业务仓库、读取环境秘密或部署。文件只写当前合成项目，日志中不得发布本机绝对路径。
消费方负责client.mjs与client.test.mjs；提供方负责service.mjs与service.test.mjs。
使用Node内置模块，不执行git提交。JSON动作类型必须精确使用当前阶段允许的plan.submit、plan.compose、plan.confirm、plan.reject、execution.report和integration.report。
`;
