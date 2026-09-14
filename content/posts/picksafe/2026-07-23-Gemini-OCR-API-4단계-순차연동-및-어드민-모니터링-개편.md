---
title: "무료 쿼터 한계를 극복하는 4단계 OCR API Fallback 파이프라인 및 실시간 벤치마크 구축기"
category: "PickSafe"
date: "2026-07-23 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "AsyncIO", "LLMOps"]
---

화장품 성분 분석 서비스 **PickSafe**에서는 사용자가 카메라로 촬영한 성분표 이미지를 정확하게 텍스트로 전환하는 **OCR(광학 문자 인식) 파이프라인**이 서비스 핵심 경험의 출발점입니다.

하지만 비전 LLM 기반 OCR API를 프로덕션 환경에 도입할 때 모든 엔지니어가 마주하는 공통 과제가 있습니다. 바로 **"무료 쿼터 제한(Rate Limit, HTTP 429) 대처"**와 **"비용 대 성능 최적화"**입니다.

이번 글에서는 단일 모델 의존성을 제거하고 서비스 가용성을 99.9% 이상으로 유지하기 위해 설계한 **Gemini API 4단계 Fallback Chain Architecture**와 **`asyncio` 기반의 5개 OCR 엔진 병렬 벤치마크 시스템** 구축 사례를 공유합니다.

---

## 1. 문제 정의 (Problem): 단일 API 의존성과 Rate Limit의 한계

초기 파이프라인은 단일 Gemini 모델에 의존하고 있었습니다. 그러나 서비스 사용량이 증가함에 따라 두 가지 치명적인 병목이 발생했습니다.

1. **HTTP 429 (Too Many Requests)로 인한 서비스 중단**:
   Gemini API의 무료 티어는 일일 요청 수(RPD)와 분당 요청 수(RPM) 제한이 엄격합니다. 특정 시간대에 스캔 요청이 몰리면 단일 모델 쿼터가 즉시 고갈되어 사용자에게 OCR 오류가 노출되었습니다.
2. **비용 및 성능 측정 기준의 부재**:
   상위 성능 모델(예: Flash 계열)과 경량화 모델(Lite 계열), 그리고 유료 상용 솔루션(Naver Clova OCR) 간의 **정확도 대비 지연시간(Latency)** 데이터가 부족하여 어떤 모델을 주력으로 설정해야 할지 객관적 판단이 어려웠습니다.

---

## 2. 기술적 고민과 아키텍처 선택 (Trade-offs)

### 고민 1. 무작위 모델 호출 vs 순차적 Fallback Chain

모든 모델에 요청을 로드 밸런싱(Random/Round-Robin)하는 방식도 고려했지만, 모델별 **쿼터 정책과 응답속도(Latency)**가 크게 달랐습니다.

- **Lite 모델 계열**: RPD가 500회로 넉넉하고 지연시간이 매우 짧음.
- **Flash 모델 계열**: 텍스트 추출 정밀도가 높지만, RPD가 20회로 제한적임.

**선택 [4단계 계층형 Fallback Chain]**:
무작위 분배 대신 **"비용/쿼터 효율이 높은 모델부터 차례대로 소모하는 순차 릴레이"** 방식을 채택했습니다.

```
[사용자 OCR 요청]
       │
       ▼
[1순위: Gemini 3.1 Flash-Lite] ──(성공)──► [결과 반환]
       │ (Quota Exceeded / 429 Error)
       ▼
[2순위: Gemini 3.5 Flash-Lite] ──(성공)──► [결과 반환]
       │ (Quota Exceeded / 429 Error)
       ▼
[3순위: Gemini 3.5 Flash]      ──(성공)──► [결과 반환]
       │ (Quota Exceeded / 429 Error)
       ▼
[4순위: Gemini 3.6 Flash]      ──(성공)──► [결과 반환]
       │ (All Failed)
       ▼
[Graceful Failure 처리 및 알림]
```

* **장점**: 서비스 가용성이 4배 이상 확장되며, 비용 효율이 높은 Lite 모델을 최우선 소모하여 운용 비용 최적화.

---

### 고민 2. 5개 OCR 엔진 성능 비교 시 블로킹(Blocking) 문제

어드민 파이프라인 모니터링을 위해 **Gemini 4종 + Naver Clova OCR 총 5개 엔진**의 정확도와 지연시간을 동시 측정해야 했습니다. 동기(Synchronous) 방식으로 순차 호출할 경우 전체 측정 시간이 각 API 지연시간의 합(예: 1.5s × 5 = 7.5s)만큼 늘어나는 성능 저하가 발생합니다.

**선택 [`asyncio.gather`를 활용한 비동기 병렬 평가]**:
Python FastAPI의 비동기 이점을 극대화하여 5개 API 호출을 동시에 수행(Non-blocking)하도록 설계했습니다. 전체 대기 시간을 **"5개 중 가장 느린 API의 지연시간(Max Latency)"**으로 단축했습니다.

---

## 3. 핵심 구현 하이라이트

보안을 위해 사내 비즈니스 로직과 보안 키는 제외하고, 핵심 아키텍처 구조를 구현한 추상화 코드입니다.

### ① 4단계 Fallback Chain 서비스 예시 (Python / FastAPI)

```python
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

class OCRPipelineService:
    def __init__(self):
        # 쿼터 한도와 지연시간 성능을 고려한 우순순위 체인 정의
        self.model_chain = [
            "gemini-3.1-flash-lite", # 1순위: 주력 (RPD 500)
            "gemini-3.5-flash-lite", # 2순위: 차선책 (RPD 500)
            "gemini-3.5-flash",      # 3순위: 상위 모델 (RPD 20)
            "gemini-3.6-flash"       # 4순위: 비상 최후 보루 (RPD 20)
        ]

    async def execute_ocr_with_fallback(self, image_bytes: bytes) -> Dict[str, Any]:
        last_exception = None

        for model_name in self.model_chain:
            try:
                # 쿼터 잔여량 사전 검증 logic (생략)
                logger.info(f"OCR 시도 중: {model_name}")
                
                result = await self._call_gemini_api(model_name, image_bytes)
                
                # 성공 시 사용량 카운터 차감 및 결과 반환
                await self._decrement_quota_metric(model_name)
                return {"status": "success", "model": model_name, "data": result}

            except RateLimitException as e:
                logger.warning(f"Model {model_name} Quota Exceeded (429). Falling back...")
                last_exception = e
                continue
            except Exception as e:
                logger.error(f"Model {model_name} Unexpected Error: {str(e)}")
                last_exception = e
                continue

        # 모든 모델 실패 시 Graceful Degradation 처리
        raise OCRExhaustedException("모든 OCR API 쿼터가 소진되었거나 오류가 발생했습니다.") from last_exception
```

### ② `asyncio.gather` 기반 5개 엔진 병렬 벤치마크 API

```python
import asyncio
from fastapi import APIRouter

router = APIRouter()

@router.post("/admin/ocr-compare/run")
async def run_ocr_benchmark(image_payload: ImagePayload):
    """
    4개 Gemini 모델 + Naver Clova OCR을 비동기 병렬로 비교 분석
    """
    engines = [
        call_gemini_3_1_lite(image_payload),
        call_gemini_3_5_lite(image_payload),
        call_gemini_3_5_flash(image_payload),
        call_gemini_3_6_flash(image_payload),
        call_naver_clova_ocr(image_payload)
    ]
    
    # 5개 API 요청을 동시 병렬 처리 (Non-blocking)
    results = await asyncio.gather(*engines, return_exceptions=True)
    
    return parse_benchmark_metrics(results)
```

---

## 4. 모니터링과 엔지니어링 교훈 (Takeaways)

### 실시간 관측 가능성(Observability) 확보
Fallback 구조를 도입한 것만으로 끝나지 않고, 어드민 대시보드를 개편하여 **4개 Gemini 모델과 Clova OCR의 실시간 RPM, 남은 쿼터(RPD), 평균 Latency**를 실시간 시각화했습니다.

이를 통해 얻은 시스템적 이점은 다음과 같습니다.

1. **무중단 OCR 파이프라인 완성**: 특정 Gemini 모델의 쿼터가 고갈되어 429 응답이 반환되어도 밀리초(ms) 단위의 Fallback으로 사용자는 장애를 전혀 체감하지 못함.
2. **비용 효율적인 AI 인프라 운용**: 일일 1,000회 이상의 무료 LLM OCR 쿼터를 안심하고 최우선 소모함으로써 초기 인프라 API 비용 절감.
3. **데이터 기반 모델 선정**: 어드민 실시간 벤치마크를 통해 텍스트 인식 정밀도와 지연시간 데이터가 쌓임에 따라, 추후 유료 전환 시 가장 ROI가 높은 모델을 선택할 수 있는 정량적 데이터베이스 확보.

### 결론
대규모 LLM/AI 외부 API를 핵심 서비스에 연동할 때 **"단일 API 실패는 언제든 일어날 수 있다"**는 전제로 시스템을 설계(Design for Failure)해야 합니다.

이번 Fallback Chain과 비동기 벤치마크 시스템 도입은 외부 의존성이 높은 인프라 환경에서 **가용 극대화, 비용 최적화, 모니터링 가시성**이라는 세 가지 토끼를 동시에 잡은 뜻깊은 엔지니어링 경험이었습니다.