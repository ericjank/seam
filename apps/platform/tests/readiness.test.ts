import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({connection:{query:vi.fn(),release:vi.fn(),destroy:vi.fn()},acquire:vi.fn()}));
vi.mock("@/db",()=>({readinessPool:{getConnection:state.acquire}}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();state.acquire.mockResolvedValue(state.connection);state.connection.query.mockResolvedValue([{affectedRows:1}]);});
it("就绪使用专用操作表提交真实写入，合并并发探测",async()=>{const {databaseWritable}=await import("../src/lib/readiness");expect(await Promise.all([databaseWritable(),databaseWritable()])).toEqual([true,true]);expect(state.connection.query).toHaveBeenCalledTimes(1);expect(state.connection.query.mock.calls[0]![0].sql).toContain("INSERT INTO readiness_probes");expect(state.connection.release).toHaveBeenCalledOnce();});
it("读取连接成功但提交不可写时返回未就绪，销毁超时连接且不暴露数据库错误",async()=>{state.connection.query.mockRejectedValue(new Error("disk full / private details"));const {databaseWritable}=await import("../src/lib/readiness");expect(await databaseWritable()).toBe(false);expect(state.connection.destroy).toHaveBeenCalledOnce();expect(state.connection.release).not.toHaveBeenCalled();});
