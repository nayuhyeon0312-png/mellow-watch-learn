mellow — Watch & Learn
======================

포함 파일
- index.html : 학습 웹사이트 화면
- server.js : Supadata 자막 API를 연결하는 서버
- package.json : 배포 플랫폼에서 실행할 명령

배포할 때
1. 이 폴더의 파일 3개(index.html, server.js, package.json)를 GitHub 저장소에 올립니다.
2. Render 등 Node.js 서버를 지원하는 호스팅 서비스에서 GitHub 저장소를 연결합니다.
3. Build Command는 비워 두거나 `npm install`, Start Command는 `npm start`로 설정합니다.
4. 환경 변수(Environment Variables)에 아래 항목을 추가합니다.
   Key: SUPADATA_API_KEY
   Value: Supadata에서 발급받은 비밀 API 키
5. 배포가 끝나면 제공된 사이트 주소를 열어 유튜브 링크를 테스트합니다.

중요
- API 키를 index.html이나 GitHub 코드에 직접 적지 마세요. 반드시 호스팅 서비스의 환경 변수에만 입력하세요.
- Supadata API 사용량/요금제와 크레딧을 공식 대시보드에서 확인하세요.
- 영어와 한국어 자막을 각각 요청한 뒤 타임스탬프가 가까운 구간끼리 연결합니다. 두 언어의 자막 구간이 다르면 일부 줄의 번역이 어긋날 수 있습니다.
- 모든 영상에 영어/한국어 자막이 있는 것은 아니며, 자동 생성 모드는 영상에 따라 처리 시간과 API 크레딧이 발생할 수 있습니다.
- 유튜브 임베드는 영상 소유자 설정 및 유튜브 정책의 영향을 받습니다.
