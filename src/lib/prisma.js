const { PrismaClient } = require('@prisma/client');

// 개발 중 핫리로드로 인해 커넥션이 여러 개 생기는 것을 방지하기 위한 싱글턴 패턴
const globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
