// customTestData 管道检查（独立脚本，由 run-mock-test.mjs 调起）。
// 用真实 PTAClient 提交一条带 customTestData 的编程题，确认：
// ① mock 返回 customTestResult，且服务端跑出的输出与样例期望一致；
// ② 自定义测试不改变题目状态（P5 仍为 PROBLEM_NO_ANSWER）。
// 用法：node test/custom-test-data-check.mjs <stateDir> <mockPort> <accountId>
// 环境变量 PTA_BASE_URL / PTA_PASSPORT_URL 由调用方传入（指向 mock）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PTAClient } from '../plugins/pta/cli/lib/pta-client.mjs';

const [stateDir, port, accountId] = process.argv.slice(2);
if (!stateDir || !port || !accountId) {
  console.error('usage: custom-test-data-check.mjs <stateDir> <mockPort> <accountId>');
  process.exit(2);
}

const session = JSON.parse(readFileSync(join(stateDir, 'accounts', accountId, 'session.json'), 'utf8'));
const client = new PTAClient(session.cookie);

const CODE = '#include <stdio.h>\nint main(){int a,b;if(scanf("%d %d",&a,&b)!=2)return 0;printf("%d",a+b);return 0;}';
const res = await client.submit('EX-MOCK-1', 'PROGRAMMING', [
  { problemId: '0', problemSetProblemId: 'P5', programmingSubmissionDetail: { program: CODE, compiler: 'GCC' } },
], { customTestData: '1 2' });
const sid = res.submissionId || res.id;
if (!sid) {
  console.error('no submissionId returned');
  process.exit(1);
}
const { judged, detail } = await client.pollSubmission('EX-MOCK-1', sid, { tries: 10, intervalMs: 1000, customTest: true });
const ctr = detail?.customTestResult;
if (!judged || !ctr) {
  console.error(`no customTestResult (judged=${judged}): ${JSON.stringify(detail).slice(0, 300)}`);
  process.exit(1);
}
const actual = String(ctr.output ?? '').trim();
if (actual !== '3') {
  console.error(`custom test output mismatch: got ${JSON.stringify(actual)}, want "3"`);
  process.exit(1);
}
const statusData = await client.problemStatus('EX-MOCK-1', 'PS-MOCK-1');
const p5 = (statusData.problemStatus || []).find((s) => (s.problemSetProblemId || s.id) === 'P5');
if ((p5?.status || p5?.problemStatus) !== 'PROBLEM_NO_ANSWER') {
  console.error(`custom test changed problem status: ${JSON.stringify(p5)}`);
  process.exit(1);
}
console.log(`CUSTOM_TEST_OK output=${JSON.stringify(actual)} status=${p5?.status || p5?.problemStatus}`);
