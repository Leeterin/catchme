// server.js에서 만든 socket.io 인스턴스를, 컨트롤러들도 가져다 쓸 수 있게 보관해두는 곳.
let ioInstance = null;

function setIo(io) {
  ioInstance = io;
}

function getIo() {
  return ioInstance;
}

module.exports = { setIo, getIo };
