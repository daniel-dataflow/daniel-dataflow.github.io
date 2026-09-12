---
title: "LLM 쿼터 정합성 확보와 UI 파편화 해결: Dynamic Config와 롤백 패턴 적용기"
category: "PickSafe"
date: "2026-08-07 09:00:00"
tags: ["Architecture", "FastAPI", "State Management", "LLM", "Troubleshooting"]
---

프로덕션 환경에서 여러 LLM(Large Language Model) API를 로드밸런싱하고 모니터링하는 시스템을 운용하다 보면, 단순히 API를 호출하는 것 이상의 엔지니어링 과제에 직면하게 됩니다. 

최근 시스템 고도화 과정에서 **1) 프론트엔드와 백엔드 간 상태 파편화, 2) 실패한 API 요청으로 인한 쿼터 집계 오차, 3) 비동기 렌더링 타이밍 이슈(Race Condition)** 라는 세 가지 주요 문제를 해결했습니다. 

본 포스팅에서는 이 문제들을 해결하기 위해 도입한 **Dynamic Config 패턴**과 **쿼터 롤백 로직**, 그리고 비동기 데이터 흐름 제어에 대한 설계 고민과 기술적 레슨을 공유합니다.

---

## 1. 마주한 문제들 (The Problems)

### 1.1. 단일 진실 소스(SSOT)의 부재와 UI 파편화
기존 구조에서는 신규 제미나이(Gemini) 모델이 추가되거나 사양이 변경될 때, 백엔드 로직뿐만 아니라 프론트엔드의 여러 자바스크립트 파일(`ocr.js`, `translations.js`, `infra.js`)에 하드코딩된 모델 리스트와 UI 테마 색상을 각각 수정해야 했습니다.

이로 인해 개발자의 실수로 특정 페이지에서 모델 정보가 누락되거나, 각 기능(OCR 성능 테스트, 대시보드, 번역 관리 등)마다 모델별 시각적 렌더링(색상, 순서)이 제각각 달라지는 **상태 불일치(State Drift)** 현상이 발생했습니다.

### 1.2. API 실패 시 쿼터 정합성 깨짐 (Quota Leakage)
제미나이 API 호출 시 분당 호출 제한(RPM) 및 일일 호출 제한(RPD)을 관리하기 위해 사전 쿼터 차감 방식을 사용하고 있었습니다. 

그러나 네트워크 타임아웃, 외부 API 서버 오류(5xx) 등 **실제 응답을 받아오지 못한 실패 건에 대해서도 사전 차감된 쿼터가 복구되지 않는 문제**가 있었습니다. 이로 인해 실시간 모니터링 대시보드의 남은 쿼터량 수치와 실제 사용 가능한 쿼터 간의 정합성이 크게 떨어졌습니다.

### 1.3. 비동기 렌더링 Race Condition
프론트엔드 초기화 시, 언어 설정 등 필수 렌더링 기반 데이터(`loadLocaleSettings`)가 로드되기 전에 메인 테이블/카드 UI가 렌더링을 시작하면서 **간헐적으로 화면 전체가 빈 상태(Blank Screen)로 노출**되는 버그가 존재했습니다.

---

## 2. 기술적 고민과 대안 비교 (Trade-offs & Decisions)

### A. Dynamic Configuration 패턴 기반 SSOT 구축

* **고민**: 모델 메타데이터(모델명, RPD/RPM 한도, UI 테마 색상)를 어디서 관리해야 하는가?
* **대안 1 (각 클라이언트 관리)**: 기존 방식 유지. 클라이언트 요청 속도는 빠르지만 유지보수 비용이 크고 변경에 취약함.
* **대안 2 (DB 기반 관리)**: DB 테이블을 추가하여 메타데이터를 저장. 유연하지만 단순 설정값을 위해 추가 IO 및 트랜잭션 비용 발생.
* **최종 선택 (백엔드 Dynamic Config & API 주입)**: 백엔드의 Service Layer(`quota_service.py`)를 단일 진실 소스(SSOT)로 지정하고, 외부 환경 변수(`.env`)를 통해 동적으로 메타데이터를 파싱하도록 설계했습니다.

```
[.env / Config] 
       │
       ▼
[Quota Service (SSOT)] ──(GET /models_meta)──► [Frontend Client]
  (Dynamic Parsing)                               (Dynamic Rendering)
```

백엔드가 `/models_meta` 형태의 메타데이터 표준 API를 내려주면, 프론트엔드는 이를 받아 동적으로 DOM 및 콤보박스, 테마 색상을 렌더링합니다. 

* **Trade-off**: 초기 화면 진입 시 메타데이터를 조회하는 1회의 API RTT가 추가되지만, 코드 수정 및 재배포 없이 **환경변수 변경만으로 운영 환경에서 신규 모델 추가/단종 및 쿼터 정책을 즉시 반영**할 수 있는 아키텍처적 이점을 얻었습니다.

> **UI Visual Identity 통일**: 제미나이의 시각적 정체성을 유지하기 위해 로고의 대표 그라데이션 컬러(Deep Blue, Purple, Pink, Orange)를 브랜드 메타데이터 표준 색상 코드로 지정하여 전역 UI에 일관되게 적용했습니다.

### B. 보상 트랜잭션 형태의 쿼터 롤백(Quota Rollback) 로직

* **고민**: API 실패 시 쿼터 정합성을 어떻게 보장할 것인가?
* **대안 1 (Post-Deduction)**: API 호출이 완벽히 성공한 후 쿼터를 차감.
  * *문제점*: 동시 요청(Concurrent Requests)이 몰릴 때 순간적으로 API 한도를 초과(Over-quota)하여 외부 API로부터 Block 당할 위험이 큼.
* **최종 선택 (Pre-Deduction with Rollback)**: 낙관적/안전 측면에서 **선 차감 후(Pre-Deduction), 예외 발생 시 보상 트랜잭션(Rollback) 수행**.

```python
# 쿼터 관리 로직 개념 예시 (Security Masked)
async def execute_llm_request(model_id: str, payload: dict):
    # 1. 쿼터 선 차감 (Pre-deduct RPD/RPM)
    await quota_service.deduct_quota(model_id)
    
    try:
        # 2. External Gemini API Call
        response = await external_llm_client.call(model_id, payload)
        return response
    except Exception as exc:
        # 3. 실패 시 쿼터 복구 (Rollback Compensating Action)
        logger.warning(f"LLM API Call failed. Rolling back quota for {model_id}. Error: {exc}")
        await quota_service.rollback_quota(model_id)
        raise exc
```

이 패턴을 통해 동시성 환경에서의 API 쿼터 초과 방지라는 안전성과, 실패 건에 대한 데이터 정합성 보장이라는 두 마리 토끼를 모두 잡았습니다.

### C. Async Flow Control & Layout Standardization

* **비동기 타이밍 이슈 해결**: JS의 `DOMContentLoaded` 이벤트 블록 내에서 비동기 설정 데이터 로딩 함수에 `await` 락(Lock)을 명시적으로 걸어, 초기 상태 데이터가 완전 구성된 후 DOM 렌더링 트리가 구동되도록 제어했습니다.
* **레이아웃 반응형 대응**: 인프라 모니터링 카드가 디바이스 해상도나 반응형 브레이크포인트에 따라 파편화되어 렌더링되던 이슈를 CSS Grid의 `grid-template-columns: repeat(2, 1fr)` 기반 규격화 구조로 통일하여 예측 가능한 UI/UX를 제공했습니다.

---

## 3. 결과 및 엔지니어링 교훈 (Takeaways)

### 3.1. 도입 성과
1. **운영 생산성 향상 (Zero-Frontend Deploy)**: 새로운 제미나이 모델(예: 3.7 버전 출시 등)이 추가되어도 프론트엔드 코드 수정 및 빌드 과정 없이, 백엔드 설정을 통해 시스템 전체에 즉시 동기화됩니다.
2. **모니터링 데이터 정합성 확보**: API 예외 상황(Timeout, 5xx 에러) 발생 시 쿼터 롤백이 즉시 실행되어 실사용량 계산 오차를 무효화했습니다.
3. **사용자 경험(UX) 개선**: 프론트엔드의 비동기 Race Condition을 원천 차단하여 빈 화면 현상을 해결하였고, 전사 시스템의 visual key를 일관성 있게 정립했습니다.

### 3.2. 엔지니어링 레슨
* **"상태는 가급적 한 곳에서 관리하라 (SSOT)"**: 프론트엔드와 백엔드 간에 공유되어야 하는 도메인 지식(모델 목록, 컬러, 제한 사항)이 클라이언트에 분산되면 반드시 기술 부채로 돌아옵니다.
* **외부 API 의존성 시스템의 방어적 설계**: 분산 환경 및 외부 Third-party API 연동 시에는 '성공' 케이스뿐만 아니라 '실패' 시 상태 보상(Rollback) 로직을 아키텍처 연동 단계부터 고려해야 데이터의 정합성을 지킬 수 있습니다.