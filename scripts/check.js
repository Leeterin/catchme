// 백엔드 기본 검사 - 코드를 고친 뒤, 커밋 전에 실행: npm test
// 1) src/, scripts/ 의 모든 .js 파일 문법 검사
// 2) 모든 라우트 파일을 실제로 불러와서(require) 오타난 함수 이름·잘못된 경로 같은 오류 확인 - 서버는 띄우지 않음
// 3) prisma/schema.prisma 형식 검사
// DB에는 접속하지 않음 (로컬 .env 의 DATABASE_URL 은 실제 운영 DB라서)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

const files = [...listJs(path.join(root, 'src')), ...listJs(path.join(root, 'scripts'))];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.log(`[실패] 문법: ${path.relative(root, f)}\n${String(e.stderr).trim()}`);
  }
}

const routesDir = path.join(root, 'src/routes');
const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));
for (const f of routeFiles) {
  try {
    require(path.join(routesDir, f));
  } catch (e) {
    failed++;
    console.log(`[실패] 불러오기: src/routes/${f}: ${e.message}`);
  }
}

try {
  execFileSync(path.join(root, 'node_modules/.bin/prisma'), ['validate'], { cwd: root, stdio: 'pipe' });
} catch (e) {
  failed++;
  console.log(`[실패] prisma 스키마:\n${String(e.stdout || '').trim()}\n${String(e.stderr || '').trim()}`);
}

if (failed) {
  console.log(`검사 실패 ${failed}건`);
  process.exit(1);
}
console.log(`검사 통과 (JS ${files.length}개 문법, 라우트 ${routeFiles.length}개 불러오기, prisma 스키마)`);
// prisma 클라이언트 등이 열어둔 핸들 때문에 안 끝나는 일이 없게 바로 종료
process.exit(0);
