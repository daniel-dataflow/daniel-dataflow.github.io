---
title: "LLM 멀티키 환경에서의 쿼터 정합성 확보와 SSOT 기반 UI 동기화 아키텍처"
category: "PickSafe"
date: "2026-08-07 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "LLM", "Frontend"]
---

생성형 AI(LLM) 기반 서비스를 운영할 때 가장 까다로운 도전 과제 중 하나는 **"제한된 API 쿼터의 효율적 관리"**와 **"빠르게 변화하는 모델 생태계에 유연하게 대응하는 프론트엔드 아키텍처 구축"**입니다. 

PickSafe 서비스 역시 다양한 이미지 OCR, 자동 번역, 인프라 모니터링 등 서비스 전반에서 Google Gemini API를 적극 활용하고 있습니다. 그러나 여러 API 키를 활용한 로드밸런싱 과정에서 **실제 API 호출 성공 여부와 쿼터 차감 간의 불일치**, 그리고 **각 기능별 프론트엔드 모듈에 파편화된 메타데이터** 문제로 인해 시스템 복잡도가 크게 증가하는 진통을 겪었습니다.

본 포스팅에서는 이 문제를 해결하기 위해 적용한 **보상 트랜잭션 개념의 쿼터 롤백 로직**과 **SSOT(Single Source of Truth) 기반의 동적 UI 메타데이터 제어 구조**, 그리고 **비동기 렌더링 병목 해결 과정**을 소개합니다.

---

## 1. 문제 정의 (Problem Statement)

운영 환경에서 관찰된 핵심 엔지니어링 문제는 크게 세 가지였습니다.

### ① API 호출 실패로 인한 '쿼터 누수' 및 정합성 유실
API 타임아웃, 외부 서비스 장애, 네트워크 분절 등으로 인해 실제 결과값을 얻지 못했음에도, API 호출 시도 시점에 쿼터(RPD, RPM)가 선차감된 후 원복되지 않는 문제가 있었습니다. 이로 인해 시스템이 집계하는 남은 쿼터량과 실제 이용 가능한 쿼터량 간에 격차가 발생했습니다.

### ② 메타데이터 파편화로 인한 유지보수 비용 증대
`OCR`, `번역`, `인프라 대시보드` 등 각 프론트엔드 모듈(`ocr.js`, `translations.js`, `infra.js`)에 사용 중인 Gemini 모델 목록, 디스플레이 순서, 테마 색상이 하드코딩되어 있었습니다. 모델 업데이트나 단종이 발생할 때마다 관련 프론트엔드 코드 전체를 수정·빌드해야 하는 불필요한 공수가 발생했습니다.

### ③ 비동기 상태 비동기화 및 비일관된 UX
- **Race Condition**: 번역 관리 화면 진입 시, 다국어 설정 로딩과 테이블 렌더링 간의 비동기 타이밍 이슈로 인해 간헐적으로 데이터를 불러오지 못하고 빈 화면이 노출되었습니다.
- **불일치한 UI Layout**: 인프라 대시보드의 카드 배치가 스크린 크기에 따라 비대칭적으로 무너지는 UI 결함이 존재했습니다.

---

## 2. 기술적 고민과 엔지니어링 의사결정 (Architecture & Trade-offs)

### Key Decision 1: SSOT(단일 진실 소스) 및 런타임 동적 환경 설정 구축

프론트엔드가 가진 모델 관련 메타데이터의 주도권을 **백엔드 레퍼런스 단일화** 방식으로 전환했습니다.

```
[System Admin (.env / Config)]
               │
               ▼
   [FastAPI Backend Service] 
   (quota_service.py - SSOT)
               │
               ├─ API Response Meta Data (/api/v1/models/meta)
               ▼
   [Dynamic Frontend Rendering]
   (OCR / Translation / Infra UI)
```

* **대안 검토**:
  * *Option A. 프론트엔드 공통 모듈(JS)화*: 빌드 타임 의존성이 유지되며 환경별 동적 변경이 어려움.
  * *Option B. DB에 메타데이터 저장*: 모델 파라미터 변경 시마다 DB 마이그레이션 및 쿼리 오버헤드 발생.
  * *Option C. 백엔드 메모리/설정 기반 SSOT + API 제공 (선택)*: `.env` 환경 변수(`GEMINI_MODELS_CONFIG`)를 통해 소스 코드 수정 및 DB 커넥션 없이 런타임 수준에서 dynamic reload 및 API 응답 메타 구조화(`models_meta`) 가능.

백엔드에서 각 모델별 식별자, 한도(RPD/RPM), 디스플레이 색상(Brand Color Guidelines)을 표준 정의하여 내려줌으로써, **새로운 모델이 추가되거나 단종되어도 프론트엔드 변경 없이 백엔드 배열 정의 1줄 수정만으로 모든 웹 UI가 자동 동기화**되도록 유연성을 확보했습니다.

### Key Decision 2: 보상 트랜잭션 형태의 Quota Rollback 로직 도입

API 쿼터 관리에 **원자성(Atomicity)**에 준하는 정합성을 부여했습니다.

```python
# Quota Management Concept Logic
async def execute_llm_task_with_quota(model_id: str, payload: dict):
    # 1. 쿼터 선차감 (RPD/RPM)
    await quota_service.deduct_quota(model_id)
    
    try:
        # 2. 실제 외부 LLM API 호출
        response = await external_llm_client.call(model_id, payload)
        return response
    except (LLMTimeoutException, ExternalAPIException, NetworkError) as e:
        # 3. Fail-safe: 호출 실패 시 쿼터 보상 원복 (Rollback)
        await quota_service.rollback_quota(model_id)
        logger.error(f"LLM Call Failed. Quota rolled back for model: {model_id}. Error: {e}")
        raise e
```

API 요청 시점에 우선적으로 RPD(Day), RPM(Minute)을 차감하여 Over-quota 방지를 보장하되, 외부 API 통신 실패 시 이를 즉시 복구(`rollback_quota`)하는 **보상 패턴**을 적용했습니다. 이를 통해 시스템 장애 요인으로 인한 억울한 쿼터 소진을 완벽히 방지할 수 있었습니다.

### Key Decision 3: 비동기 파이프라인 제어 및 UI Grid 정규화

* **Race Condition 해소**: DOM 생성 이벤트 처리 과정에서 다국어 가속 설정(`loadLocaleSettings`)의 Promise가 전파 완료될 때까지 테이블 렌더링을 명시적으로 차단하도록 `async/await` 파이프라인을 정비했습니다.
* **Layout Consistency**: 카드 컨테이너에 CSS Grid를 적용, `grid-template-columns: repeat(2, 1fr)` 레이아웃 고정을 통해 디바이스 스크린 변화와 무관하게 2x2 형태의 대칭성을 유지하도록 개선했습니다.

---

## 3. 엔지니어링 성과 및 레슨 선장 (Takeaway)

이번 개선 활동을 통해 다음과 같은 기술적/비즈니스적 성과를 달성했습니다.

1. **운영 효율성 극대화 (Developer Experience)**
   * 새로운 LLM 모델 도입 시 필요한 코딩 작업이 완전 제거되었습니다. 백엔드 설정값 업데이트만으로 서비스 전반의 UI 색상, 렌더링 순서, 쿼터 제한 모니터링이 실시간으로 적용됩니다.
2. **데이터 정합성 증대 (Cost & Quota Efficiency)**
   * API 오류 시 쿼터 롤백 프로세스를 구비함으로써, 실제 소비량 데이터 측정 오차율을 0%에 가깝게 정밀화했습니다.
3. **프론트엔드 신뢰성 확보 (User Experience)**
   * 비동기 데이터 로딩 순서 제어를 통해 간헐적으로 발생하던 UI Blank 현상을 완벽히 해결하고, 통일된 브랜드 디자인 자산(Brand Identity)을 대시보드 전반에 적용했습니다.

### 마무리하며
시스템이 확장되고 외부 API 의존성이 높아질수록 **"실패를 고려한 데이터 정합성 설계"**와 **"시스템 메타데이터의 백엔드 주도 제어(SSOT)"**가 얼마나 중요한지 재확인할 수 있었습니다. 앞으로도 PickSafe 팀은 견고하고 확장 가능한 AI 서비스 인프라를 구축하기 위해 기술적 도전을 계속해 나갈 것입니다.