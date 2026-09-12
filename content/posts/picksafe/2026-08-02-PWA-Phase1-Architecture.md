---
title: "PickSafe의 PWA Phase 1 도입기: 오프라인 캐싱보다 '앱 설치'를 먼저 챙긴 이유"
category: "PickSafe"
date: "2026-08-02 09:00:00"
tags: ["Architecture", "PWA", "FastAPI", "Frontend", "Troubleshooting"]
---

안녕하세요, PickSafe 백엔드 및 웹 엔지니어입니다. 

모바일 환경에서의 접근성이 서비스 성패를 가르는 중요한 지표가 되면서, 저희 팀은 최근 사용자들이 네이티브 앱처럼 서비스를 이용할 수 있도록 **PWA(Progressive Web App)** 도입을 결정했습니다. 

이번 글에서는 PWA 도입 초기, 완벽한 오프라인 지원이라는 거창한 목표 대신 **'홈 화면 설치(Add to Home Screen)' 기능 확보에만 집중**하기로 한 아키텍처적 의사결정(ADR) 과정과, FastAPI 환경에서 마주한 스코프(Scope) 문제를 해결한 경험을 공유하려 합니다.

---

## 1. Problem: 사용자는 왜 브라우저 주소창 입력을 귀찮아할까?

PickSafe는 모바일 기기에서의 접속 빈도가 압도적으로 높은 서비스입니다. 하지만 기존 웹 브라우저 환경에서는 몇 가지 명확한 UX 허들이 존재했습니다.
* 사용자가 매번 Safari나 Chrome을 켜고 북마크를 찾거나 URL을 직접 입력해야 함
* 브라우저 상단 UI(주소창 등)로 인해 실제 컨텐츠 영역이 줄어듦
* 네이티브 앱과 같은 몰입감 있는 진입 경험 부재

이를 해결하기 위해 PWA 도입을 논의하게 되었으나, 개발 리소스와 서비스 안정성을 고려했을 때 **"한 번에 모든 PWA 기능을 구현하는 것이 맞을까?"**라는 의문이 생겼습니다.

---

## 2. Trade-off & Decision: Phase 1은 '오프라인'이 아니라 '설치'에 올인한다

PWA를 검색하면 흔히 등장하는 개념이 **오프라인 캐싱(Offline Caching)**과 **백그라운드 동기화**입니다. 하지만 저희는 1차 도입(Phase 1) 단계에서 다음과 같은 **Trade-off**를 감수하기로 했습니다.

### 2.1 서비스 워커(Service Worker) 캐싱 정책 전면 보류
* **고민**: Service Worker를 활용해 정적 에셋과 API 응답을 공격적으로 캐싱하면 속도는 빨라지지만, 배포 후 리소스가 갱신되지 않는(Stale Cache) 치명적인 장애 위험이 있습니다.
* **결정**: 1차 배포의 최우선 목적은 오프라인 동작이 아닌 **"홈 화면에 앱 설치 지원"**입니다. 이에 따라 `service-worker.js` 파일은 브라우저 등록을 위해 생성하되, 내부의 네트워크 가로채기(Fetch / Install 이벤트) 로직은 완전히 비워두기로 했습니다.
* **효과**: 캐싱 관련 장애 원인을 원천 차단하고, PWA 설치 기능 자체가 안정적으로 동작하는지 우선 검증할 수 있었습니다.

### 2.2 어드민 영역의 명확한 배제 (Scope Separation)
* **고민**: 모든 페이지에 일괄적으로 PWA 스크립트를 주입하는 것이 구현은 편하지만, 보안과 관리 측면에서 어드민 페이지까지 홈 화면에 추가될 필요는 없습니다.
* **결정**: 공통 레이아웃(`base.html`)을 사용하는 일반 사용자 화면(홈, 스캔, 결과, 마이페이지 등)에만 PWA 관련 스크립트와 메타 태그를 포함하고, 어드민 영역은 완전히 배제했습니다.

---

## 3. Implementation: FastAPI 환경에서의 루트(Root) 서빙 이슈 해결

PWA를 구현하며 마주한 기술적 허들 중 하나는 **서비스 워커의 스코프(Scope) 제약**이었습니다. 
서비스 워커는 기본적으로 자신이 위치한 디렉토리 하위의 경로만 통제할 수 있습니다. 예를 들어 스크립트가 `/static/js/`에 위치한다면 도메인 전체를 제어하는 데 제약이 생깁니다.

PickSafe의 백엔드는 **FastAPI**로 구축되어 있으며, 정적 자원은 전통적으로 `/static/` 경로를 통해 서빙되고 있었습니다. 도메인 전체(`https://domain.com/`)에서 매니페스트와 서비스 워커를 원활히 인식하게 하기 위해, `main.py`에 별도의 라우팅 엔드포인트를 구성했습니다.

```python
# FastAPI를 활용한 루트 경로 서빙 예시 (개념 코드)
from fastapi import FastAPI
from fastapi.responses import FileResponse

app = FastAPI()

@app.get("/manifest.json")
async def get_manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json")

@app.get("/service-worker.js")
async def get_service_worker():
    return FileResponse("static/js/service-worker.js", media_type="application/javascript")
```

이를 통해 파일은 정적 디렉토리에 관리하면서도, 브라우저는 최상단 루트 경로(`https://domain.com/service-worker.js`)로 인식하여 정상적으로 스코프를 확장할 수 있었습니다.

---

## 4. Validation & Takeaway

도입 후 다음과 같은 시나리오를 바탕으로 철저한 검증을 거쳤습니다.

1. **iOS Safari 검증**: 아이폰에서 '홈 화면에 추가' 진행 시, 지정한 아이보리 파스텔 톤(`#FFF8F0`)의 테마 컬러와 리사이징된 아이콘(192x192, 512x512)이 스플래시 화면과 함께 정상 노출되는지 확인
2. **어드민 격리 검증**: 관리자 페이지 진입 시 서비스 워커가 등록되지 않으며 앱 설치 프롬프트가 뜨지 않는지 확인
3. **Android Chrome 검증**: 모바일 크롬 접속 시 하단에 네이티브 앱과 유사한 설치 팝업이 안정적으로 트리거되는지 확인

### 💡 오늘의 Takeaway
> **"복잡한 기술을 한 번에 도입하기보다, 비즈니스 목적에 맞게 범위를 쪼개는 것이 엔지니어링의 본질이다."**

이번 PWA Phase 1 도입은 화려한 오프라인 기능을 포기하는 대신, **"사용자를 우리 서비스에 더 가깝게 안착시킨다"**는 명확한 목적에 집중한 의사결정였습니다. 과도한 엔지니어링(Over-engineering)을 경계하고 단계적으로 가치를 전달하는 방식이 얼마나 안정적인 결과를 내는 다시 한번 체감할 수 있었습니다. 

다음 페이즈에서는 안정화된 설치 기반 위에서 제한적인 캐싱 전략을 점진적으로 도입할 계획입니다. 읽어주셔서 감사합니다!