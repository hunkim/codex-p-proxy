# codex-p-proxy

> **개인용입니다.** 내 ChatGPT 구독으로 내 컴퓨터에서 나 혼자 쓰는 용도로 만들었습니다.

`codex exec`(Codex CLI)를 OpenAI API 호환으로 감싼 로컬 서버. [claude-p-proxy](https://github.com/hunkim/claude-p-proxy)의 Codex 버전입니다.
SDK에서 `base_url`만 바꾸면 그대로 붙습니다. 텍스트, 스트리밍, 이미지 입력, function calling 지원.

## 설치·실행

```bash
git clone https://github.com/hunkim/codex-p-proxy && cd codex-p-proxy
npm install          # Codex CLI도 함께 설치됨
npx codex login      # 처음 한 번: ChatGPT 계정으로 로그인
npm start            # http://127.0.0.1:8790
```

이미 `codex`를 전역 설치해 쓰고 있다면 `npm install` 없이 `node server.mjs`만 해도 됩니다.

포트는 `npm start -- --port 9000`으로 바꿀 수 있습니다. 지정하지 않았는데 8790이 사용 중이면 8791, 8792…로 자동으로 넘어가니 실제 주소는 시작 로그에서 확인하세요.

## 사용

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="local")
print(c.chat.completions.create(model="gpt-6.2-sol",
      messages=[{"role": "user", "content": "안녕"}]).choices[0].message.content)
```

Open WebUI, LibreChat 같은 채팅 UI에는 OpenAI 호환 주소로 `http://127.0.0.1:8790/v1`을 넣으면 됩니다.

## 엔드포인트

- `POST /v1/chat/completions` — OpenAI 호환
- `GET /v1/models` (`codex debug models` 목록), `GET /health`

모델 목록에 있는 이름이면 그 모델로, `gpt-4o` 같은 나머지는 `DEFAULT_MODEL`(없으면 Codex 기본 모델)로 갑니다.
`reasoning_effort`(low~ultra)는 `model_reasoning_effort`로 넘어갑니다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8790` | `--port`가 `PORT`보다 우선 |
| `DEFAULT_MODEL` | (Codex 기본값) | |
| `DEFAULT_EFFORT` | `low` | 요청에 `reasoning_effort`가 없을 때 |
| `MAX_CONCURRENT` | `2` | 동시에 띄울 `codex` 프로세스 수 |
| `LOCAL_API_KEY` | (없음) | 설정하면 `Authorization: Bearer` 확인 |
| `TIMEOUT_MS` | `300000` | 요청당 제한 시간 |
| `DEFAULT_SYSTEM` | 간단한 지시문 | system 메시지가 없을 때 |
| `MAX_IMAGE_BYTES` | 10MB | URL 이미지 최대 크기 |
| `CODEX_BIN` | 자동 | CLI 경로 (기본: `node_modules`의 CLI → PATH의 `codex`) |

## 동작 방식

- 요청마다 빈 임시 폴더에서 `codex exec --json --ephemeral -s read-only`를 띄웁니다. `~/.codex/config.toml`(MCP, 훅, 기본 모델)은 읽지 않고 로그인 정보만 씁니다.
- Codex는 코딩 에이전트라 기본으로 스킬·플러그인·샌드박스 설명과 도구가 잔뜩 붙습니다. 이를 끄고 시스템 프롬프트를 바꿔 요청당 입력 토큰을 약 17k → 4.5k로 줄였습니다.
- 대화 기록은 텍스트 하나로 합치고, 이미지는 임시 파일로 저장해 `--image`로 넘깁니다. URL 이미지는 서버가 내려받습니다.
- Function calling: 도구 정의를 시스템 프롬프트에 넣고 `<tool_calls>[...]</tool_calls>` JSON 블록으로 답하게 한 뒤, 서버가 꺼내 `tool_calls` 형식으로 돌려줍니다. 인자가 스키마에 맞는다는 보장은 없으니 중요한 곳에서는 검증하세요.
- `OPENAI_API_KEY`·`CODEX_API_KEY`는 자식 프로세스에서 지워 구독 한도만 씁니다.

## 한계

- **스트리밍은 가짜입니다.** `codex exec`가 토큰 단위 출력을 주지 않아, 답이 완성된 뒤 한 번에 보냅니다.
- 첫 응답까지 수 초 (프로세스 시작 비용), 요청마다 약 4.5k 입력 토큰 고정 비용
- temperature·max_tokens·stop 등은 무시, PDF·오디오 입력 미지원
- 사용량은 ChatGPT 앱·Codex와 같은 구독 한도에서 빠집니다
