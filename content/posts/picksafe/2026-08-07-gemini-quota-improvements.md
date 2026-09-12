---
title: "멀티 LLM 환경에서의 Single Source of Truth 구축과 API 쿼터 정합성 해결기"
category: "PickSafe"
date: "2026-08-07 09:00:00"
tags: ["Architecture", "FastAPI", "Frontend", "Refactoring", "Concurrency"]
---

프로덕션 환경에서 여러 인공지능(AI) 모델을 서비스에 통합해 활용하다 보면, 단순히 API를 호출하는 것을 넘어 **"어떻게 쿼터를 효율적으로 관리하고, 파편화된 UI/UX 상태를 유지보수 가능하게 만들 것인가"**라는 엔지니어링 과제에 직면하게 됩니다.

최근 저희 팀은 다양한 제미나이(Gemini) 모델을 멀티 키(Multi-Key) 기반으로 로드밸런싱하며 운영하는 과중에서, **프론트엔드 메타데이터의 파편화**, **네트워크 예외로 인한 쿼터 정합성 이탈**, **비동기 렌더링 레이스 컨디션(Race Condition)** 문제를 해결했습니다.

이 글에서는 서비스 확장성을 해치던 기술 부채를 어떤 아키텍처적 의사결정(Trade-off)을 통해 해결했는지, 그 과정과 엔지니어링 레슨을 공유합니다.

---

## 1. 문제 정의 (Problem Definition)

서비스 규모가 확장되고 다양한 제미나이 모델 라인업(Flash, Flash-Lite 등)을 적용하면서 다음과 같은 3가지 핵심 기술 문제가 발생했습니다.

### ① 파편화된 메타데이터 (Single Source of Truth 결여)
각 화면(OCR 성능 테스트, 번역 관리, 인프라 모니터링 등)의 자바스크립트 파일(`ocr.js`, `translations.js` 등)마다 사용 가능한 모델 목록과 UI 표시 색상이 하드코딩되어 있었습니다. 모델이 새로 추가되거나 단종될 때마다 수많은 프론트엔드 파일을 일일이 찾아 수정해야 하는 구조적 한계가 존재했습니다.

### ② API 호출 실패 시 쿼터 정합성 깨짐 (Quota Leakage)
요청 전 실행되는 쿼터 차감 로직에서 RPD(일일 한도)와 RPM(분당 한도)을 선차감하였으나, 외부 API 서버 오류나 타임아웃 발생 시 **차감된 쿼터를 원상 복구(Rollback)하지 않는 문제**가 있었습니다. 이로 인해 실제 성공한 호출량과 시스템이 기록한 쿼터 간의 오차가 점점 벌어졌습니다.

### ③ 비동기 순서 보장 실패 (Race Condition) 및 UI 불일치
프론트엔드 초기화 시, 언어/환경 설정 데이터가 완료되기 전에 테이블 렌더링이 실행되어 간헐적으로 빈 화면이 노출되었습니다. 또한, 해상도에 따라 모니터링 카드의 그리드 레이아웃이 유동적으로 깨지는 UX 불일치가 발생했습니다.

---

## 2. 기술적 고민과 대안 비교 (Trade-offs & Alternatives)

### 고민 1: 프론트엔드 빌드 파이프라인 vs 백엔드 동적 메타데이터 API

*   **대안 A: 프론트엔드 공통 모듈/JSON 파일 도입**
    *   *장점*: API 호출 없이 빠르게 static 데이터를 로드할 수 있음.
    *   *단점*: 모델 정책 변경 시마다 프론트엔드 재빌드 및 배포가 필요함.
*   **대안 B (선택): 백엔드 단일 진실 소스(SSOT) + 동적 메타데이터 API 전달**
    *   *장점*: 백엔드의 `.env` 및 설정 객체(`quota_service.py`) 단 한 곳만 변경하면, 프론트엔드는 호출 시 동적으로 최신 모델 메타데이터(`models_meta`)를 받아 렌더링함. 배포 없이 환경변수 조정만으로 제어 가능.
    *   *선택 이유*: 시스템 확장성과 무배포 모델 운영(Zero-downtime Ops)을 위해 **대안 B**를 선택했습니다.

### 고민 2: 쿼터 차감 방식 (Strict Distributed Lock vs Optimistic Rollback)

*   **대안 A: 분산 락(Distributed Lock) 기반의 비관적 쿼터 관리**
    *   *장점*: 완벽한 동기화 보장.
    *   *단점*: API 호출마다 락 오버헤드가 발생하여 LLM 응답 지연 시간(Latency)이 증가함.
*   **대안 B (선택): 낙관적 선차감 후 예외 발생 시 롤백 (Optimistic Decrement with Rollback)**
    *   *장점*: 추가적인 락 오버헤드가 없어 레이턴시에 영향을 주지 않음.
    *   *선택 이유*: LLM API 연동에서는 대역폭과 속도가 중요하므로, 선차감 후 호출 실패(`Try-Catch`) 시 쿼터를 복구하는 **Rollback 패턴**이 훨씬 효율적이라고 판단했습니다.

---

## 3. 최종 해결 방안 (Implementation Details)

### A. 백엔드 중심 Single Source of Truth (SSOT) 구축

백엔드 설정 객체 내에 모델의 한도, 렌더링 시그니처 색상 등의 메타데이터를 통합 정의했습니다.

```python
# [백엔드 서비스 로직 예시 - 개념 추상화]
# 소스코드 수정 없이 코어 설정을 동적으로 로드
GEMINI_MODELS_CONFIG = parse_env_config()

class QuotaService:
    def get_models_metadata(self) -> dict:
        """
        프론트엔드 동적 렌더링을 위한 메타데이터 제공 API 엔드포인트 응답 객체 생성
        """
        return {
            model_id: {
                "name": config.name,
                "color": config.color, # 예: 제미나이 퍼플(#9333ea), 핑크(#ec4899) 등
                "rpm": config.rpm,
                "rpd": config.rpd
            }
            for model_id, config in GEMINI_MODELS_CONFIG.items()
        }
```

프론트엔드는 페이지 로드 시 이 `models_meta` 정보를 받아와 드롭다운 콤보박스와 쿼터 카드 UI를 동적으로 생성하도록 전면 리팩토링했습니다.

### B. Reliable Quota Rollback 패턴 적용

API 호출 과정에서 발생하는 타임아웃, 5xx 에러 등의 예외 처리 블록에 쿼터 복원 로직을 이식했습니다.

```python
# [쿼터 관리 서비스 예시]
async def execute_llm_request(model_id: str, payload: dict):
    # 1. 쿼터 선차감 (Optimistic Decrement)
    await quota_service.consume_quota(model_id)
    
    try:
        # 2. 외부 LLM API 호출
        response = await external_llm_client.call(model_id, payload)
        return response
    except Exception as exc:
        # 3. 호출 실패 시 쿼터 롤백 (Rollback)
        logger.error(f"LLM API 호출 실패. 쿼터 복구를 시작합니다. Model: {model_id}, Error: {exc}")
        await quota_service.rollback_quota(model_id)
        raise exc
```

### C. 프론트엔드 Race Condition 및 Responsive Layout 개선

*   **비동기 동기화**: `DOMContentLoaded` 체인에서 언어 설정(`loadLocaleSettings`)을 `await`로 명시적 순서를 보장한 후 테이블을 렌더링하도록 변경하여 빈 화면 현상을 원천 차단했습니다.
*   **레이아웃 통일**: 가변적이던 모니터링 카드의 CSS Grid를 `grid-template-columns: repeat(2, 1fr)`로 표준화하여 대시보드의 시각적 안정성을 확보했습니다.

---

## 4. 성과 및 엔지니어링 교훈 (Takeaways)

### 📈 성과 (Impact)
1.  **유지보수성 향상 (Zero-FE-Change)**: 새로운 LLM 모델이 추가되거나 단종되더라도, 프론트엔드 코드 수정 및 배포 없이 백엔드 설정만으로 전체 UI 환경이 자동으로 동기화됩니다.
2.  **데이터 정합성 확보**: API 호출 실패 시의 롤백 메커니즘을 통해 실제 LLM 사용량 모니터링 모듈의 신뢰도를 99.9% 이상으로 끌어올렸습니다.
3.  **사용자 경험(UX) 개선**: 프론트엔드의 비동기 로딩 레이스 컨디션을 해결하여 화면 깜빡임과 빈 데이터 표시 버그를 완벽히 제거했습니다.

### 💡 엔지니어링 교훈 (Lessons Learned)
*   **"기술 부채는 코드의 양이 아니라 파편화된 상태(Truth)에서 온다."**
    설정 데이터가 프론트엔드 여러 파일에 분산되어 있을 때 발생하는 스파게티 구조를 **SSOT 원칙**으로 통합함으로써 시스템 관리 비용을 극적으로 낮출 수 있었습니다.
*   **"외부 의존성이 높은 API 시스템은 반드시 보상 트랜잭션(Compensation logic)을 고려해야 한다."**
    타사(Third-party) API는 언제든 실패할 수 있습니다. 시스템 내부의 상태(쿼터 등)를 변경할 때는 성공을 가정한 선차감 구조에 대응하는 **롤백 및 복구 전략**이 필수적이라는 점을 재확인했습니다.