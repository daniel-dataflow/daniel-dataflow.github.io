---
title: "LLM 멀티 모델 아키텍처의 진화: Single Source of Truth와 쿼터 정합성 확보기"
category: "PickSafe"
date: "2026-08-07 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "API-Integration"]
---

서비스가 성장함에 따라 다양한 거대 언어 모델(LLM)을 유연하게 도입하고 관리하는 능력이 중요해지고 있습니다. 저희 PickSafe 팀에서는 제미나이(Gemini) API를 중심으로 멀티 키 로드밸런싱 및 쿼터 관리 시스템을 구축하여 운영해 왔습니다. 

하지만 기능이 확장되면서 개발자라면 누구나 한 번쯤 겪게 되는 성장통을 마주하게 되었습니다. **프론트엔드와 백엔드 간의 데이터 파편화, 네트워크 예외 상황에서의 데이터 부정합, 그리고 비동기 렌더링으로 인한 미세한 UX 결함**이 그것이었습니다.

이번 포스팅에서는 외부의 고성능 API를 안정적으로 서빙하기 위해 저희 팀이 어떻게 **'단일 진실 소스(Single Source of Truth)'**를 정의하고, **'쿼터 정합성'**을 확보했으며, **'시스템 모니터링 UI/UX'**를 개선했는지 그 치열한 고민의 과정을 공유합니다.

---

## 1. 문제 정의: 무엇이 시스템의 안정성을 위협했는가?

저희 팀이 마주한 문제는 크게 세 가지 레이어에서 발생했습니다.

### ① 설정의 파편화 (Hardcoded Configurations)
새로운 LLM 모델(예: Gemini 3.5, 3.6 등)이 추가되거나 관리 정책이 변경될 때마다 백엔드 코드뿐만 아니라 프론트엔드의 여러 자바스크립트 파일(`ocr.js`, `translations.js`, `infra.js` 등)을 일일이 수정해야 했습니다. 각 화면마다 모델을 표현하는 순서나 브랜드 색상 정의가 제각각 달라, UI/UX의 통일성이 깨지고 유지보수 비용이 기하급수적으로 증가했습니다.

### ② 쿼터 차감의 부정합 (Unreliable Quota Accounting)
LLM API 호출은 네트워크 지연, 제공사측 장애, 타임아웃 등 다양한 외부 요인으로 실패할 수 있습니다. 기존 시스템은 API 호출 직전 로컬 DB/캐시에서 쿼터(RPD/RPM)를 차감하는 구조였는데, **실제 호출이 실패했음에도 이미 차감된 쿼터가 복구되지 않는 문제**가 있었습니다. 이로 인해 사용자는 실제 할당량보다 적은 서비스를 이용하게 되는 정합성 오류가 발생했습니다.

### ③ 비동기 레이스 컨디션 및 레이아웃 붕괴 (Race Condition & Layout Drift)
관리자 대시보드에서 언어 설정 및 메타데이터를 비동기로 불러오는 과정에서, 데이터 로드가 완료되기 전에 화면 렌더링이 시작되어 빈 화면이 순간적으로 노출되는 레이스 컨디션이 발생했습니다. 또한, 반응형 그리드가 고정되지 않아 모니터링 카드가 디바이스 크기에 따라 무작위로 배치되는 시각적 불안정성이 있었습니다.

---

## 2. 기술적 고민과 대안 비교: Trade-off

이 문제들을 근본적으로 해결하기 위해 아키텍처적 관점에서 몇 가지 대안을 비교했습니다.

### Q1. 모델 설정 정보를 어디에서 관리할 것인가?
*   **대안 A: 프론트엔드 빌드 타임에 주입 (Static Config)**
    *   *장점:* 가볍고 백엔드 추가 API 호출이 필요 없음.
    *   *단점:* 모델 하나 추가할 때마다 프론트엔드 전체 배포 필요. 운영 유연성 제로.
*   **대안 B: 데이터베이스(DB) 관리**
    *   *장점:* 완전한 동적 관리 가능.
    *   *단점:* 단순 설정 조회를 위해 매번 DB 커넥션을 맺어야 하므로 오버헤드 발생.
*   **선택한 해결책: 백엔드 Config 기반의 Dynamic Metadata-driven UI**
    *   백엔드(`quota_service.py`)에 단일 진실 소스(SSOT)가 되는 구조체를 정의하고, 이를 환경 변수(`.env`)와 결합하여 메모리 상에서 관리합니다. 백엔드는 프론트엔드가 요구할 때 이 메타데이터(`models_meta`)를 API 엔드포인트로 내려줍니다. 
    *   이 방식은 DB 조회 오버헤드 없이, **소스 코드 수정 없이 환경 변수 설정만으로 실시간으로 모델 라인업, 한도(RPD/RPM), UI 테마 색상을 변경**할 수 있는 최적의 Trade-off 지점이었습니다.

### Q2. 실패한 API 요청에 대한 쿼터 보호를 어떻게 할 것인가?
*   **대안 A: API 호출 완료 후 사후 차감 (Post-deduction)**
    *   *위험성:* 호출은 성공했으나 차감 직전 서버가 다운되면, 사용자가 제한 없이 API를 호출할 수 있는 보안 취약점(Rate-limit 우회)이 발생함.
*   **선택한 해결책: 롤백(Rollback) 메커니즘을 포함한 선차감 (Pre-deduction with Rollback)**
    *   안전성을 위해 API 호출 전에 쿼터를 먼저 차감(Pre-deduction)하되, API 호출 과정에서 예외(`try-except`)가 발생하면 차감했던 분당 한도(RPM)와 일일 한도(RPD)를 원상 복구(Rollback)하는 로직을 트랜잭션 단위로 묶어 처리했습니다.

---

## 3. 최종 해결 및 엔지니어링 구현

### A. 싱글 소스 오브 트루스(SSOT) 구축
백엔드에 모델 설정 메타데이터를 일원화하고, 브랜딩 일관성을 위해 제미나이의 시그니처 그라데이션 색상을 차용하여 구조화했습니다.

```python
# [보안 처리 완료된 개념적 구조 예시]
# quota_service.py
AVAILABLE_MODELS = {
    "gemini-3.5-flash-lite": {
        "displayName": "Gemini 3.5 Flash-Lite (Main)",
        "color": "#2563eb",  # 제미나이 딥 블루
        "rpd_limit": 10000,
        "rpm_limit": 15
    },
    "gemini-3.5-flash": {
        "displayName": "Gemini 3.5 Flash",
        "color": "#9333ea",  # 퍼플
        "rpd_limit": 5000,
        "rpm_limit": 10
    },
    "naver-clova": {
        "displayName": "Clova",
        "color": "#059669",  # 네이버 그린 (제미나이 계열과 겹치지 않게 분리)
        "rpd_limit": 3000,
        "rpm_limit": 5
    }
}
```

이 메타데이터를 프론트엔드가 호출 시 동적으로 바인딩하여 렌더링함으로써, **새로운 모델이 추가되더라도 백엔드 배열 단 한 줄의 변경만으로 전체 시스템의 대시보드, 모니터링 카드, 드롭다운이 자동으로 동기화**되는 쾌거를 이루었습니다.

### B. 예외 복원력이 강화된 쿼터 롤백 파이프라인
네트워크 타임아웃이나 API 공급사 측 장애 발생 시, 시스템이 오작동하여 쿼터가 증발하는 현상을 아래와 같은 파이프라인 구조로 방어했습니다.

```python
async def execute_llm_request_with_quota(user_id: str, model_id: str, payload: dict):
    # 1. 쿼터 선차감 시도
    quota_acquired = await quota_manager.deduct_quota(user_id, model_id)
    if not quota_acquired:
        raise HTTPException(status_code=429, detail="Quota exceeded")

    try:
        # 2. 실제 외부 LLM API 호출 (I/O Bound)
        response = await external_llm_client.call(model_id, payload)
        return response
    except Exception as exc:
        # 3. 에러 발생 시 즉시 롤백 로직 수행 (정합성 유지)
        await quota_manager.rollback_quota(user_id, model_id)
        logger.error(f"API call failed. Quota rolled back for user {user_id}. Error: {exc}")
        raise HTTPException(status_code=502, detail="External API Failure - Quota Recovered")
```

### C. 프론트엔드 비동기 레이스 컨디션 및 레이아웃 제어
`DOMContentLoaded` 이벤트 시점에 비동기 함수 호출 순서가 꼬여 데이터가 빈 칸으로 나오던 현상은 정교한 `await` 시퀀싱으로 해결했습니다.

```javascript
// translations.js - AS-IS (Race Condition 발생)
document.addEventListener('DOMContentLoaded', () => {
    loadLocaleSettings(); // 비동기 함수가 완료되기 전에
    renderTranslationTable(); // 이 함수가 실행되어 빈 데이터가 렌더링됨
});

// TO-BE (순차 보장)
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadLocaleSettings(); // 다국어 설정 완료를 명확히 대기
        await renderTranslationTable(); // 이후 안정적으로 렌더링
    } catch (error) {
        console.error("Initialization failed:", error);
    }
});
```

더불어, 중구난방이던 인프라 쿼터 모니터링 화면을 CSS Grid를 활용한 `grid-template-columns: repeat(2, 1fr)` 레이아웃으로 통일하여, 어떠한 해상도에서도 안정적인 2x2 대시보드를 시청할 수 있도록 인터페이스 완성도를 끌어올렸습니다.

---

## 4. 성과 및 엔지니어링 교훈 (Takeaways)

이번 개선 작업을 통해 저희 팀은 다음과 같은 정량적/정성적 성과를 거두었습니다.

1.  **유지보수성 극대화:** 신규 LLM 모델 탑재 시 프론트엔드 빌드 및 배포 과정이 완전히 생략되었습니다. 오직 환경 변수 설정과 백엔드 메타데이터 업데이트만으로 UI 구성부터 차감 정책까지 **Zero-Downtime**으로 동적 적용이 가능해졌습니다.
2.  **데이터 신뢰성 확보:** 쿼터 차감의 정합성이 100%에 수렴하게 되었습니다. 네트워크 에러로 인해 사용자가 쿼터를 부당하게 소실하는 경험(Bad UX)을 원천 차단했습니다.
3.  **UI/UX 일관성 및 시각적 통일성:** 브랜드 아이덴티티를 살린 일관된 테마 컬러 적용과 레이아웃 제어를 통해 모니터링 도구의 시각적 완성도를 극대화했습니다.

### 💡 에디터의 한 줄 평
> "진정한 시니어 엔지니어링은 화려한 신기술을 도입하는 것에 그치지 않습니다. 분산된 상태를 단일화(SSOT)하고, 예외 상황에서의 데이터 복원력(Resilience)을 설계하며, 미세한 UX 레이스 컨디션까지 꼼꼼하게 통제하는 디테일에서 시스템의 격이 결정됩니다."