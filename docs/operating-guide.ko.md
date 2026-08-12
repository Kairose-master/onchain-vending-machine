# 운영자 매뉴얼 (부스 가이드)

이 문서 하나로 부스를 처음부터 끝까지 굴릴 수 있게 쓴 매뉴얼.
설치 → 하드웨어 → 결제 → 4개 레인 → Handsel 정산 → 트러블슈팅 순서.
트러블슈팅 항목은 전부 실제로 겪은 것들이다.

## 0. 전체 그림

```
손님이 USDC 전송 ──> 워처가 체인에서 감지
   ├─ 금액이 어떤 슬롯의 가격과 정확히 일치 → 그 슬롯 서보가 실물 상품 배출
   ├─ 금액이 카드 가격 이상               → 키오스크 크레딧 1 → 펜 플로터가 카드 제작
   └─ (설정 시) 카드마다 Handsel에 실제 잡 생성 → 채점 → 정산 → 서명된 증명
```

원칙 두 가지, 절대 안 바뀜:
- **테스트넷 전용.** Sepolia 토큰은 가치 0인 선물. 실물 굿즈만 실제 돈으로 판다.
  "USDC를 현금으로 바꿔드립니다" 류의 문구는 어떤 UI에도 절대 넣지 않는다.
- **가짜 숫자 없음.** 판매 수, 수익, 지급 내역은 전부 실제 트랜잭션이거나 아예 표시하지 않는다.

## 1. 설치

```bash
git clone https://github.com/kairose-master/onchain-vending-machine
cd onchain-vending-machine/watcher
npm install                  # 중국이면: npm install --registry=https://registry.npmmirror.com
cp .env.example .env
npm test                     # 85개 전부 그린이어야 정상
npm run dev                  # 키오스크: http://localhost:8787
```

`.env` 최소 한 줄: `VENDING_WALLET_ADDRESS=` (부스 수금 지갑 주소).
플로터/디스펜서 미연결이면 드라이런 — 플롯이 `./out/*.gcode` 파일로 떨어진다.

> `git pull` 받은 뒤 `module not found` 나오면 무조건 `npm install` 먼저.

## 2. 하드웨어 — 펜 플로터

GRBL/ESP32 오픈 키트 (작업 영역 60×60mm). 연결은 USB 또는 WiFi 중 하나.

### USB 시리얼

```bash
ls /dev/cu.*                 # macOS. CH340 보드는 usbserial-N — 재연결 때마다 번호가 바뀔 수 있음
```
`.env`: `PLOTTER_SERIAL=/dev/cu.usbserial-10`

- `screen /dev/cu.usbserial-10 115200` 으로 수동 콘솔. **나올 땐 Ctrl+A, K, y** —
  그냥 창을 닫으면 좀비 세션이 포트를 물고 있어서 워처가 "Resource busy"로 실패한다.
  이미 그 상태면: `screen -ls` → `screen -X -S <ID> quit`.
- 보드가 시리얼 열릴 때 자동 리셋되는 문제, 부팅 배너를 ok로 오인하는 문제,
  DTR/RTS가 리셋을 잡고 있는 문제는 전부 코드가 처리한다
  (부트 핸드셰이크, 엄격한 ok 파싱, `PLOTTER_DTR`/`PLOTTER_RTS` 오버라이드).
  디버그가 필요하면 `PLOTTER_DEBUG=1`로 원시 수신 덤프.

### WiFi (텔넷) — USB가 죽었을 때의 플랜 B이자 부스 권장 구성

보드 펌웨어(ESP3D)가 자체 AP `GRBL_ESP`를 띄운다 (기본 비번 `12345678`, IP `192.168.0.1`).
부스에서는 AP 모드 대신 **STA 모드로 폰 핫스팟에 합류**시키는 게 정답이다 —
그래야 노트북이 인터넷(체인 감시)과 보드(플롯)를 동시에 본다.

1. `GRBL_ESP`에 접속 → http://192.168.0.1 → ESP3D Settings
2. Station SSID / Station Password 입력 → Set, Radio Mode → `STA` → Set
   (웹 표에 없으면 GRBL 탭 콘솔에서 `$Sta/SSID=...` `$Sta/Password=...` `$Radio/Mode=STA`)
3. 보드 전원 재시작 → `GRBL_ESP`가 목록에서 사라져야 성공
4. 새 IP 찾기: `ping grblesp.local` — 안 되면 서브넷 스캔:
   ```bash
   SUBNET=$(ipconfig getifaddr en0 | cut -d. -f1-3)
   for i in $(seq 1 254); do (nc -z -G 1 $SUBNET.$i 23 2>/dev/null && echo "FOUND $SUBNET.$i") & done; wait
   ```
5. `.env`: `PLOTTER_SERIAL=` 비우고 `PLOTTER_TCP=<보드IP>:23`

주의: **ESP32는 5GHz를 못 본다.** 아이폰 핫스팟이면 "호환성 최대화" ON.
핫스팟은 잠들면 양쪽 다 끊기니 운영 중엔 핫스팟 화면을 켜둔다.
IP는 재접속 때 바뀔 수 있다 — 접속 불량이면 IP부터 다시 확인.

### 펜/기계 캘리브레이션

- **펜 높이 규칙: "펜다운 상태에서 맞춘다."** 콘솔에서 펜다운 명령
  (예: `M3 S70`) → 펜을 종이에 닿고 1~2mm 더 내려 고정(스프링이 살짝 눌리게)
  → 펜업 명령으로 2~3mm 뜨는지 확인. 스프링은 펜을 **아래로 미는** 방향이어야 한다.
- 펜 서보 명령은 기계마다 다르다 — `.env`의 `PEN_UP_CMD` / `PEN_DOWN_CMD`.
- 글자가 뭉개지거나 작게 나오면 스텝 로스다: `FEED_DRAW=600 FEED_TRAVEL=1500`
  낮추기. (촘촘한 한자에서 특히 — 코드가 0.15mm 미만 세그먼트를 이미 걸러준다.)
- 원점 복귀: `G90 G0 X0 Y0`, 현 위치를 원점으로: `G92 X0 Y0`.
- 테스트 플롯: `npx tsx scripts/plot-direct.ts "안녕"` (결제 큐 우회, 운영자 전용).
- 기계 없이 미리보기: `npx tsx scripts/preview.ts "문구"` → `out/sample-preview.svg`.

## 3. 하드웨어 — 디스펜서 (슬롯용, 선택)

`firmware/onchain_vending/onchain_vending.ino` + **제작 설명서 `docs/dispenser-build.ko.md`** (회로·골판지 조립·캘리브레이션 전체).
슬롯당 서보 1개 (`SLOT_SERVO_PINS`, 기본 4채널: GPIO 18/19/21/22).
스케치에 WiFi와 워처 주소 넣고 플래시. ESP32가 `/slot-dispenses`를 폴링해서
어느 슬롯 서보를 돌릴지 받아가고, **실물 동작 후에** ack한다.

서보 전원은 별도 5V로 (ESP32 5V핀은 브라운아웃). 스마트 충전기는 저전류에서
출력을 끊으니 **일반 어댑터** 사용.

## 4. 결제

- 가격: `.env`의 `PRICE_USDC` (기본 0.01) — 카드(플로터) 레인의 가격.
- 손님 안내: 부스 지갑 주소 QR을 인쇄해 두고, Base Sepolia USDC를 보내면 된다.
- 시연/테스트용 USDC: https://faucet.circle.com (Base Sepolia 선택).
  파우셋에서 부스 지갑으로 직접 보내도 결제로 인식된다.
- 입금 후 몇십 초 안에 키오스크 "결제 대기"가 올라간다. 안 올라가면 §8 참고.

## 5. 키오스크 레인 사용법

http://localhost:8787 — 탭 4개.

### 문구 / 이미지 (기본 레인)
크레딧 1개 소모. 문구는 80자까지(줄바꿈 가능, 한/중/영 — 폰트 체인이 자동 선택),
이미지는 업로드 + 선 추출 강도 슬라이더. **미리보기 먼저, 그리기 시작은 그다음.**
이미지 탭의 **"📷 카메라로 찍기"** = 즉석 초상화: 노트북 웹캠으로 찍으면 같은
트레이싱 파이프라인을 타고 초상화 카드가 나온다 (찍으면 추출 강도가 130으로
자동 조정 — 얼굴은 라인아트보다 살짝 어둡게 잡는 게 잘 나온다). 카메라는
보안 컨텍스트에서만 열리므로 부스 노트북에서 **localhost로** 접속할 것 —
LAN IP로 열면 브라우저가 카메라를 막는다 (업로드는 그대로 동작).
플롯 성공 후에만 크레딧이 차감된다 (기계가 중간에 죽으면 손해는 부스 몫,
손님 몫이 아니다).

### 갤러리 (레시피 마켓 — 남의 디자인을 이 기계에서 판다)
- **등록 (무료)**: 갤러리 탭 → "내 디자인 등록하기" → 이름/작가명/지갑(선택)/문구
  또는 이미지. 등록 시점에 실제 파이프라인으로 "그릴 수 있는지" 검사해서
  못 그리는 디자인은 거부된다.
- **판매**: 손님이 갤러리에서 디자인 선택 → 크레딧으로 플롯.
- **분배**: 판매마다 작가 `RECIPE_AUTHOR_BPS`(기본 70%) / 부스 30%.
  `ROYALTY_PAYER_KEY`(또는 `HANDSEL_PAYER_KEY` 재사용)가 있으면 **판매 즉시
  작가 지갑으로 실제 USDC 전송 + tx 링크 표시**. 없으면 "적립"으로만 표시.
  ⚠ 일반 ERC-20 전송은 가스가 필요하다 — 그 키에 Base Sepolia ETH 약간 필요
  (x402는 가스리스라 착각하기 쉬움).

### 슬롯 (슬롯 마켓 — 실물 상품 운영권)
- **임대**: 슬롯 탭 → "슬롯 임대하기" → 빈 슬롯 선택, 상품명/운영자명/지갑/
  **가격(다른 슬롯·카드와 달라야 함)**/재고 수량. 등록 후 실물 재고를 직접 채운다.
- **판매**: 손님이 **그 슬롯의 정확한 금액**을 부스 지갑에 보내면 해당 서보가
  배출한다. 금액이 곧 주소다 (ERC-20엔 메모가 없어서).
- **분배**: 판매마다 임차인 `SLOT_LESSEE_BPS`(기본 80%) / 기계 20%. 지급 방식은
  레시피와 동일 (핫키 있으면 즉시 온체인, 없으면 적립).
- **매진**: 매진 슬롯에 돈이 들어오면 환불 원장에 기록되고 핫키가 있으면
  자동 환불된다. 조용히 먹는 경우는 없다.

### Handsel 정산 (카드 1장 = 라이브 잡 1건)
`.env`에 `HANDSEL_PAYER_KEY` / `HANDSEL_EMAIL` / `HANDSEL_PASSWORD` 세 줄.
부팅 로그에 `[handsel] worker agent ...`가 뜨면 연결 성공. 이후 플롯마다
키오스크 하단에 타임라인이 실시간으로 흐른다:
잡 등록 중 → 에스크로 완료 → 클레임 → 제출 완료 → 정산 완료.
(x402 등록비 $0.10/카드 — 페이어 키 주소에 파우셋 USDC를 받아둘 것. 가스는 불필요.)
https://handsel-nu.vercel.app/guest 에서 그 잡이 공개로 보인다.

### 기계 노동 (외부 바운티를 이 기계가 수행)
`.env`에 `MACHINE_WORKER=1` 추가 (Handsel 세 줄 필요). 30초마다 공개 피드에서
제목에 `[machine:plot]`이 있는 Open 잡을 찾아 — 설명의 `plot: <문구>` 줄을
파싱해서 — 클레임하고, 실물로 그리고, 생산 기록을 제출한다.
- 파싱 안 되는 잡은 클레임하지 않고 남긴다.
- 키오스크 손님이 항상 우선 (펜 잠금 공유), 틱당 1건.
- 증거는 통계+G-code이고 제출물에 "카메라 없음"이 명시된다 — 정직이 스펙이다.
- **수요 쪽 사용법**: handsel-nu에 제목 `[machine:plot] 응원 카드`,
  설명 `plot: 오늘도 화이팅` 형식으로 잡을 올리면 된다 (대시보드 또는
  x402 `POST /api/jobs/external`).

## 6. `.env` 전체 요약

`.env.example`에 전 항목이 주석과 함께 있다. 묶음만 요약:

| 묶음 | 키 | 없으면 |
|---|---|---|
| 필수 | `VENDING_WALLET_ADDRESS` | 부팅 불가 |
| 결제 | `PRICE_USDC`, `POLL_INTERVAL_MS`, `SCAN_WINDOW_BLOCKS` | 기본값으로 동작 |
| 플로터 | `PLOTTER_SERIAL` **또는** `PLOTTER_TCP`, `WORK_AREA_MM`, `PEN_UP_CMD`, `PEN_DOWN_CMD`, `FEED_DRAW`, `FEED_TRAVEL`, `FONT_PATH` | 드라이런 (G-code 파일) |
| Handsel | `HANDSEL_PAYER_KEY`, `HANDSEL_EMAIL`, `HANDSEL_PASSWORD` | 정산 레인 OFF |
| 레시피 | `RECIPE_AUTHOR_BPS`, `ROYALTY_PAYER_KEY` | 70/30, 적립만 |
| 슬롯 | `SLOT_COUNT`, `SLOT_LESSEE_BPS` | 4채널, 80/20 |
| 기계 노동 | `MACHINE_WORKER`, `MACHINE_NAME` | 레인 OFF |

키는 절대 커밋/채팅에 올리지 않는다. 전부 테스트넷 소액 전용 일회용 키만 쓴다.

## 7. 행사 당일 체크리스트

1. 폰 핫스팟 ON (호환성 최대화, 자동잠금 해제) → 노트북+플로터 보드 합류 확인
2. `ping grblesp.local` → IP 확인 → `.env`의 `PLOTTER_TCP` 갱신
3. `npm run dev` → 부팅 로그에서 확인: `[plotter] machine at ...(wifi)`,
   `[handsel] worker agent ...`, `[recipes] ...`, `[machine-work] ON`
4. `plot-direct.ts "테스트"`로 실물 1장 → 펜 높이/크기 확인
5. 파우셋 입금 1회 → 키오스크 크레딧 올라가는지 확인
6. 부스 지갑 QR, 슬롯 실물 재고, 예비 종이/펜 배치
7. (영상용) 화면 녹화는 `Cmd+Shift+5`, 저장 위치는 옵션에서 다운로드로

## 8. 트러블슈팅 (전부 실제 사례)

| 증상 | 원인 → 처치 |
|---|---|
| 결제했는데 크레딧이 안 올라감 | RPC 폴 실패(로그 확인) 또는 금액이 어떤 슬롯 가격과 일치해 슬롯 레인으로 감. 워처가 오래 꺼져 있었다면 스캔 윈도우(약 2000블록) 밖의 입금은 못 본다 — 워처는 부스 운영 중 상시 켜둘 것 |
| `Resource busy` (시리얼) | screen 좀비 세션 → `screen -ls` / `screen -X -S <ID> quit` |
| 보드가 안 잡힘 (`ls /dev/cu.*`에 없음) | 재연결 시 포트 번호 변경 확인 → 케이블/포트 교체 → `system_profiler SPUSBDataType`가 비어 있으면 맥 USB 스택이 죽은 것: 재부팅, 그래도 안 되면 WiFi 경로로 전환 (§2) |
| "GRBL never woke up" | 보드 전원(모터 5V 어댑터 포함) 확인 → 스마트 충전기가 출력을 끊었을 수 있음(일반 어댑터로) → `PLOTTER_DEBUG=1`로 수신 확인 |
| ok는 오는데 모터가 안 움직임 | 모터 전원 미연결. 로직(USB)과 모터(5V) 전원은 별개다 |
| 글자가 아주 작게/뭉개져서 나옴 | 스텝 로스 → `FEED_DRAW` 낮추기 (600 권장) |
| 특정 문자에서 "no drawable strokes" | 폰트 체인에 해당 글리프 없음 → `FONT_PATH`에 커버 폰트 추가 (한글 Nanum Pen, 한자 Ma Shan Zheng은 기본 포함) |
| 펜이 허공에서 그림 | 펜 높이 규칙(§2 캘리브레이션) — 서보가 아니라 펜 물림 높이 문제 |
| 핫스팟에서 갑자기 다 끊김 | 핫스팟이 잠든 것 → 핫스팟 화면 켜두기, 보드 전원 재시작 → IP 재확인 |
| 로열티/정산 지급 실패 로그 | 키에 가스(ETH) 없음 — 지급은 "적립"으로 안전하게 남아 있음. Base Sepolia ETH 파우셋에서 소액 받아 재시도 |
| Handsel 잡이 "claimed-elsewhere" | 공개 시장에서 다른 워커가 선점 — 오류가 아니라 시장이 작동한 것 |
| 카메라 버튼이 "열 수 없어요" | LAN IP로 접속함 (getUserMedia는 localhost/HTTPS 전용) → 부스 노트북에서 http://localhost:8787 로 열기 |
| 중국에서 npm/입력 문제 | `--registry=https://registry.npmmirror.com`; 중문 입력기의 전각 따옴표(" ")가 셸을 `dquote>`로 만든다 — Ctrl+C 후 반각으로 |

## 9. 데이터/상태 파일

| 파일 | 내용 | 지워도 되나 |
|---|---|---|
| `state.json` | 크레딧 큐 + 본 tx 해시 (이중지급 방지) | 지우면 스캔 윈도우 내 과거 입금이 재크레딧될 수 있음 — 운영 중 삭제 금지 |
| `recipes.json` | 등록 디자인 + 작가 수익 원장 | 지우면 갤러리/원장 소실 |
| `slots.json` | 슬롯 임대 + 재고 + 배출 큐 + 환불 원장 | 지우면 임대 정보 소실 |
| `out/` | 드라이런 G-code / 미리보기 | 자유 |
