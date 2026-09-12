---
title: "무료 티어 한계를 극복하는 고가용성 OCR 파이프라인 구축기: 4단계 Fallback Chain과 실시간 벤치마크 도입"
category: "PickSafe"
date: "2026-07-23 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "Python", "Asynchronous"]
---

안녕하세요. 화장품 성분 분석 및 추천 서비스 **PickSafe**의 백엔드 엔지니어링 팀입니다. 

PickSafe 서비스의 핵심 유저 경험 중 하나는 사용자가 화장품 성분표를 사진으로 찍어 업로드했을 때, 이를 정확하고 빠르게 텍스트로 추출(OCR)하여 유해 성분을 분석해 주는 것입니다. 이 과정에서 OCR 엔진의 가용성과 정확도는 서비스의 생존과 직결됩니다.

최근 저희 팀은 제한된 리소스 속에서 **API 비용을 극적으로 절감하면서도, 서비스 가용성을 99.9% 수준으로 끌어올리기 위해 진행한 OCR 파이프라인 아키텍처 개편 작업**을 소개해 드리고자 합니다. 

LLM API의 속도 제한(Rate Limit) 문제를 애플리케이션 레이어에서 우아하게 해결하고, 데이터 기반의 의사결정을 위해 실시간 벤치마킹 도구까지 구축한 여정을 공유합니다.

---

## 1. 우리가 마주한 문제 (Problem)

기존 PickSafe의 OCR 모듈은 단일 LLM API 모델에 의존하고 있었습니다. 하지만 프로덕션 환경이 커지면서 다음과 같은 치명적인 한계에 직면했습니다.

1. **잦은 Rate Limit (HTTP 429) 발생:** 무료 및 저비용 LLM API는 일일 요청 제한(RPD) 및 분당 요청 제한(RPM)이 엄격합니다. 사용자가 몰리는 특정 시간대에 단일 모델만 사용하다 보니 `429 Too Many Requests` 에러가 발생하여 유저가 스캔 실패를 경험하는 일이 잦아졌습니다.
2. **비용 효율성과 성능의 트레이드오프:** 정확도가 높은 고성능 모델은 무료 쿼터가 극도로 적고(일 20회), 쿼터가 넉넉한 라이트 모델(일 500회)은 피크 타임에 가용성을 온전히 보장하기 어려웠습니다.
3. **가시성(Visibility) 부족:** 어떤 모델이 현재 시점에서 가장 빠른지, 인식률이 높은지 실시간으로 비교할 수 있는 정량적 지표가 없었습니다. 외부 OCR 서비스(예: Naver Clova OCR)와 Gemini 모델군 간의 성능 비교를 감에 의존해 판단해야 하는 문제가 있었습니다.

---

## 2. 해결을 위한 기술적 고민과 대안 (Trade-off)

우리는 이 문제를 해결하기 위해 크게 두 가지 아키텍처 패턴을 고민했습니다.

### 고민 1. 로드 밸런싱(Load Balancing) vs 폴백 체인(Fallback Chain)
*   **로드 밸런싱:** 여러 API 키나 모델에 요청을 무작위 혹은 라운드 로빈 방식으로 분산하는 방식입니다. 하지만 이 방식은 쿼터 한도가 서로 다른 모델들(예: 일 500회 vs 일 20회)의 특성을 고려하기 어려워, 특정 고성능 모델의 쿼터가 조기에 소진되는 문제가 있었습니다.
*   **폴백 체인(Fallback Chain - 순차 연동):** 가장 비용 효율적이고 쿼터가 넉넉한 모델을 1순위로 시도하고, 실패(Rate Limit 혹은 타임아웃) 시 다음 순위의 모델로 순차적으로 요청을 넘기는(Failover) 방식입니다. 

> **결정:** 무료 쿼터 이용 효율을 극대화하기 위해 **4단계 폴백 체인(Fallback Chain)** 아키텍처를 선택했습니다. 

```
[유저 OCR 요청]
       │
       ▼
┌────────────────────────┐
│ 1순위: 3.1 Flash-Lite  │ ──(성공)──> [텍스트 반환]
└────────────────────────┘
       │ (Fail / 429)
       ▼
┌────────────────────────┐
│ 2순위: 3.5 Flash-Lite  │ ──(성공)──> [텍스트 반환]
└────────────────────────┘
       │ (Fail / 429)
       ▼
┌────────────────────────┐
│ 3순위: 3.5 Flash       │ ──(성공)──> [텍스트 반환]
└────────────────────────┘
       │ (Fail / 429)
       ▼
┌────────────────────────┐
│ 4순위: 3.6 Flash       │ ──(성공)──> [텍스트 반환]
└────────────────────────┘
       │ (모두 실패 시)
       ▼
[최종 시스템 에러 핸들링]
```

*   **1~2순위(주력):** 쿼터가 넉넉한(일 500회 / 15 RPM) `Flash-Lite` 모델 배치로 대부분의 트래픽 소화.
*   **3~4순위(백업):** 쿼터는 적지만 성능이 확실한 `Flash` 모델(일 20회 / 5 RPM)을 최후의 보루로 배치.

### 고민 2. 벤치마킹 시 동기식 순차 실행 vs 비동기 병렬 실행
각 모델별 성능과 인식률을 실시간으로 비교하기 위한 어드민 도구를 만들 때, 5개의 엔진(Gemini 4종 + Naver Clova OCR)을 어떻게 테스트할 것인가가 쟁점이었습니다.
*   **동기식 순차 실행:** 코드가 직관적이지만, 5개 API를 차례대로 호출하면 총 대기 시간이 각 API 지연 시간의 합(최대 10~15초)이 되어 사용성이 크게 떨어집니다.
*   **비동기 병렬 실행 (`asyncio.gather`):** 파이썬의 비동기 이벤트를 활용해 5개 엔진에 동시에 요청을 보내고 병렬로 결과를 수집합니다. 전체 대기 시간은 '가장 느린 API의 지연 시간'으로 단축됩니다.

> **결정:** 어드민 페이지의 실시간성과 성능 향상을 위해 FastAPI의 비동기 강점을 극대화할 수 있는 **`asyncio.gather` 기반의 병렬 벤치마크 아키텍처**를 채택했습니다.

---

## 3. 최종 구현 및 엔지니어링 디테일

### 1) 4단계 폴백 체인 (Python Pattern)
백엔드 핵심 비즈니스 로직(`ocr_service.py`)에 구현된 폴백 체인의 핵심 개념 코드입니다. (보안을 위해 내부 API 엔드포인트 및 상세 로직은 마스킹 및 추상화 처리되었습니다.)

```python
import logging
from typing import Optional, List

logger = logging.getLogger(__name__)

class OCRPipelineService:
    def __init__(self):
        # 쿼터 및 우선순위를 고려한 모델 후보군 정의
        self.model_candidates = [
            {"name": "gemini-3.1-flash-lite", "priority": 1},
            {"name": "gemini-3.5-flash-lite", "priority": 2},
            {"name": "gemini-3.5-flash", "priority": 3},
            {"name": "gemini-3.6-flash", "priority": 4}
        ]

    async def execute_ocr_with_fallback(self, image_data: bytes) -> str:
        last_exception = None
        
        for model_info in self.model_candidates:
            model_name = model_info["name"]
            try:
                logger.info(f"Trying OCR with model: {model_name} (Priority: {model_info['priority']})")
                
                # 실제 API 호출부 (추상화됨)
                result = await self._call_gemini_api(model_name, image_data)
                
                # 성공 시 사용량 차감 및 결과 반환
                await self._decrement_quota_store(model_name)
                return result
                
            except Exception as e:
                # Rate Limit(429)이나 Timeout 발생 시 경고를 남기고 다음 모델로 순차 진행
                logger.warning(f"Failed to process OCR with {model_name}. Error: {str(e)}. Proceeding to next fallback.")
                last_exception = e
                continue
        
        # 모든 Fallback Chain이 실패했을 경우의 최종 예외 처리
        logger.error("All OCR models in the fallback chain failed.")
        raise RuntimeError("OCR_PIPELINE_TEMPORARILY_UNAVAILABLE") from last_exception

    async def _call_gemini_api(self, model_name: str, image_data: bytes) -> str:
        # 비동기 external API 호출 로직 위치
        pass

    async def _decrement_quota_store(self, model_name: str):
        # 내부 Redis/DB를 활용한 실시간 사용량 및 남은 쿼터 데크리먼트 처리
        pass
```

### 2) 비동기 병렬 실시간 벤치마크 (`asyncio.gather`)
어드민 관리자가 여러 엔진의 성능을 실시간으로 비교 분석할 수 있도록, 5개 엔진을 동시에 호출하는 벤치마크 API의 핵심 구조입니다.

```python
import asyncio
import time
from fastapi import APIRouter

router = APIRouter(prefix="/admin/ocr-compare")

async def benchmark_single_engine(engine_name: str, image_data: bytes) -> dict:
    start_time = time.perf_counter()
    try:
        # 각 엔진별 독립 비동기 호출 (예시용 가상 메서드)
        text_result = await call_specific_ocr_engine(engine_name, image_data)
        latency = time.perf_counter() - start_time
        return {
            "engine": engine_name,
            "status": "SUCCESS",
            "latency_seconds": round(latency, 3),
            "character_count": len(text_result)
        }
    except Exception as e:
        latency = time.perf_counter() - start_time
        return {
            "engine": engine_name,
            "status": "FAILED",
            "latency_seconds": round(latency, 3),
            "error_message": str(e)
        }

@router.post("/run")
async def run_ocr_benchmark(image_payload: dict):
    # 테스트 이미지 데이터 로드 (보안 마스킹)
    image_data = get_test_image_bytes(image_payload.get("image_id"))
    
    engines = [
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
        "clova-ocr" # 외부 상용 엔진 대조군
    ]
    
    # asyncio.gather를 통한 5개 엔진의 논블로킹(Non-blocking) 동시 요청 실행
    tasks = [benchmark_single_engine(engine, image_data) for engine in engines]
    results = await asyncio.gather(*tasks)
    
    return {
        "benchmark_timestamp": time.time(),
        "results": results
    }
```

---

## 4. 도입 결과 및 비즈니스 가치

1. **가용성 99.9% 달성 (장애율 0% 수렴):** 
   특정 모델의 Rate Limit(429)이나 일시적인 네트워크 순단이 발생하더라도, 유저는 에러 화면을 보는 대신 백업 모델을 통해 즉시 OCR 결과를 제공받게 되었습니다. 체인 도입 이후 사용자 시점에서의 OCR 실패율은 사실상 0%에 수렴하고 있습니다.
2. **인프라 비용 극대화 절감:** 
   일일 쿼터가 500회인 Lite 모델 두 개를 우선적으로 소모하도록 설계하여, 유료 과금 단계로 넘어가기 전 무료 티어 자원을 끝까지 짜내어 활용할 수 있게 되었습니다. 초기 스타트업 단계에서 서버 운영 비용을 크게 아낄 수 있는 실용적인 아키텍처적 해법이 되었습니다.
3. **데이터 기반의 엔진 의사결정:** 
   새로 도입한 어드민 대시보드(4개 Gemini 모델 + Clova 실시간 지연시간/사용량 추적 인터페이스) 덕분에 기획자와 개발자 모두가 "현재 어떤 모델이 가성비와 정확도 측면에서 최적인지" 한눈에 파악하고 파이프라인의 우선순위를 즉각 조정할 수 있는 통제력을 갖게 되었습니다.

---

## 5. 엔지니어링 교훈 (Takeaway)

이번 개편을 진행하며 저희 팀은 다음과 같은 소중한 교훈을 얻었습니다.

*   **외부 API는 언제든 실패할 수 있음을 가정하라:** 써드파티 API나 LLM 서비스는 영원히 안정적일 수 없습니다. 시스템 아키텍처 설계 시 **회복 탄력성(Resilience)**과 **우아한 성능 저하(Graceful Degradation)**를 기본 탑재해야만 견고한 서비스를 만들 수 있습니다.
*   **성능 비교는 실측 기반이어야 한다:** 막연히 "새 모델이 더 빠르고 좋겠지"라는 추측 대신, `asyncio.gather`를 활용해 상용 서비스와 LLM 오픈 API의 벤치마크 데이터를 실시간 대조함으로써 정량적이고 객관적인 기술 의사결정을 내릴 수 있었습니다.

PickSafe 팀은 한정된 리소스 안에서도 최적의 사용자 경험을 제공하기 위해 백엔드 아키텍처를 끊임없이 고도화하고 있습니다. 앞으로도 기술로 서비스를 단단하게 만드는 여정을 기대해 주세요!