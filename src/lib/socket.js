// server.js에서 만든 socket.io 인스턴스를, 컨트롤러들도 가져다 쓸 수 있게 보관해두는 곳.
let ioInstance = null;

function setIo(io) {
  ioInstance = io;
}

function getIo() {
  return ioInstance;
}

// 계정 정지/삭제 때, 이미 열려있는 그 사람의 실시간 연결을 바로 끊음 (안 끊으면 계속 새 메시지를 받음)
function disconnectUser(userId) {
  if (!ioInstance) return;
  ioInstance.in(`user:${userId}`).disconnectSockets(true);
}

module.exports = { setIo, getIo, disconnectUser };
