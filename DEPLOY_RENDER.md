# 스마트폰만으로 Render에 배포하기

이 프로젝트는 Render Web Service에 바로 배포할 수 있도록 `render.yaml`을 포함합니다.
배포 후에는 PC를 켜 둘 필요가 없습니다.

## 1. GitHub에 올리기

스마트폰 브라우저에서 GitHub에 로그인한 뒤 새 저장소(repository)를 만듭니다.
예: `rummikub-multiplayer`

이 ZIP의 `rummikub-4p` 폴더 안 파일들을 저장소의 최상위(root)에 업로드합니다.
중요: `render.yaml`, `package.json`, `server.js`, `public` 폴더가 저장소 최상위에 있어야 합니다.

## 2. Render에 연결하기

1. https://dashboard.render.com 에 로그인합니다.
2. New > Blueprint 를 선택합니다.
3. 방금 만든 GitHub 저장소를 연결합니다.
4. Render가 `render.yaml`을 읽으면 Apply/Deploy를 진행합니다.
5. 배포가 끝나면 `https://...onrender.com` 주소가 생성됩니다.

직접 Web Service로 만들어도 됩니다.
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: Free
- Region: Singapore

## 3. 스마트폰에서 사용

생성된 `https://...onrender.com` 주소를 Safari/Chrome에서 엽니다.
함께 플레이할 사람들에게 같은 주소를 보내고 방 코드를 공유하면 됩니다. 한 방에 최대 4명까지 참가할 수 있습니다.

### Android / Galaxy
Chrome에서 앱의 `앱으로 설치` 버튼을 누르거나 브라우저 메뉴의 `홈 화면에 추가`/`앱 설치`를 사용합니다.

### iPhone / iPad
Safari에서 공유 버튼(□↑) > `홈 화면에 추가`를 선택합니다.

## 주의

- 게임 방/진행 상태는 서버 메모리에 저장됩니다. Render가 재시작되면 진행 중인 방은 사라집니다.
- 무료 인스턴스는 장시간 사용하지 않으면 잠들 수 있어 첫 접속이 늦을 수 있습니다.
- 이 게임은 실시간 대전이므로 인터넷 연결이 필요합니다. PWA로 설치해도 오프라인 게임은 지원하지 않습니다.
