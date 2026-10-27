# 맞춤형 학습지 생성기 (v5)

교과서 PDF를 올리면 AI가 교과서의 개념·문제·그림을 그대로 살린 **컬러 학습지**를 만들고,
**학생용 / 교사용(정답·풀이 포함) HWPX(한글 문서)** 로 내려받을 수 있습니다.

## 주요 기능
- **여러 AI 선택**: Google Gemini(무료 사용량 있음), Anthropic Claude(Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1),
  OpenAI(GPT-6 Astra / GPT-6.1 Sol / Terra / GPT-6 Luna), OpenAI 호환 API(OpenRouter 등, 주소·모델 직접 입력).
  회사마다 키를 따로 저장합니다.
- **교과서 문제 그대로**: 문제·예제·생각해보기는 교과서 문장을 그대로 옮기고 새로 지어내지 않습니다.
- **교과서 그림 그대로**: AI가 그림 위치(좌표)를 찾고 앱이 교과서 페이지에서 잘라 넣습니다.
  어긋나면 그림 아래 [✂ 위치 조정], 빠진 그림은 각 칸의 [+ 그림]으로 직접 지정합니다.
- **개념 구조화**: 탐구 → 핵심 개념(빈칸) → 개념 확인 → 풀이 전략 → 교과서 문제 → 생각해보기.
- **학생용/교사용 분리**: 교사용은 빈칸 정답(빨강)과 문제 정답·풀이가 들어갑니다.
- **정답 검산**: 교과서 이미지와 대조해 옮겨 적은 문제와 정답을 한 번 더 검토합니다.
- **HWPX 내보내기**: 표·색·그림·한글 수식(수식 편집기로 수정 가능)이 들어간 한글 문서.
- 구성 참고 학습지(선택): 평소 학습지의 활동 흐름만 참고합니다. 디자인은 색 테마로 새로 만듭니다.

## 배포 (Vercel 무료)
1. 이 폴더의 **내용물**을 GitHub 저장소에 올립니다.
2. vercel.com → Add New Project → 저장소 선택 → Deploy (환경변수 필요 없음).

## 로컬 실행
npm install && npm run dev → http://localhost:3000

## 구조
- `app/page.js` 입력·생성 흐름 / `app/api/proxy/route.js` (선택) 서버 경유 연결
- `components/WorksheetView.js` 학습지 미리보기 / `components/CropEditor.js` 그림 위치 편집기
- `lib/llm.js` AI 회사별 스트리밍 호출 / `lib/prompt.js` 지시문 / `lib/jsonRepair.js` 응답 복구
- `lib/doc.js` 학습지 데이터 정리 / `lib/rich.js` 수식·빈칸 표기 해석
- `lib/pdfClient.js` PDF → 이미지 / `lib/figures.js` 그림 잘라내기·보정
- `lib/hwpx.js` HWPX 생성 / `lib/latex2hwp.js` LaTeX → 한글 수식 / `lib/eqMeasure.js` 수식 크기
- `lib/themes.js` 색 테마 / `lib/sample.js` 샘플 학습지

제3자 코드 고지는 `THIRD_PARTY_NOTICES.md`를 보세요.
