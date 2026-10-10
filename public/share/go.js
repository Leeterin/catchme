// 링크 미리보기 페이지(/i/:token)를 사람이 열면 바로 캐치미 화면으로 넘김 (미리보기 수집기는 스크립트를 안 돌려서 안 넘어감)
location.replace(document.body.getAttribute('data-target'));
