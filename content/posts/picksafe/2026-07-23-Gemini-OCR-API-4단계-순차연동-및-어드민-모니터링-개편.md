---
title: "외부 API 한계를 극복하는 아키텍처: 4단계 Fallback Chain과 비동기 벤치마킹 시스템 구축기"
category: "PickSafe"
date: "2026-07-23 09:00:00"
tags: ["Architecture", "Resilience", "FastAPI", "AsyncIO", "OCR"]
---

화장품 성분 분석 서비스 **PickSafe**의 핵심 기능은 사용자가 촬영한 성분표 이미지를 실시간으로 OCR 분석하여 유해 성분을 판별하는 것입니다. 하지만 서비스가 성장하면서 external AI API의 **Rate Limit(HTTP 429 Too Many Requests)**과 쿼터 제한(RPD/RPM)은 서비스 가용성(Availability)을 위협하는 치명적인 병목 요소로 떠올랐습니다.

이번 포스팅에서는 외부 API의 트래픽 한계를 극복하기 위해 설계한 **4단계 API 순차 연동(Fallback Chain) 아키텍처**와, 서비스 성능을 극대화하기 위해 구축한 **비동기 멀티 엔진 벤치마킹 시스템**의 엔지니어링 여정을 공유합니다.

---

## 1. Problem: 단일 모델 의존성과 API Quota의 한계

OCR 파이프라인에서 단일 LLM/OCR 모델에만 의존할 경우 두 가지 주요 문제점이 발생합니다.

1. **서비스 가동성 문제 (Single Point of Failure)**: 순간적인 트래픽 폭증이나 일일 호출 한도(RPD) 초과 시, `HTTP 429` 에러가 발생하며 사용자의 스캔 요청이 즉각 실패합니다.
2. **비용 및 자원 효율성 타협**: 고성능 모델은 쿼터(일일 20회 등)가 매우 제한적이며, 대량 처리용 Lite 모델은 쿼터(일일 500회 등)가 여유롭습니다. 모든 요청을 단일 모델로 처리하는 것은 경제성 및 지속 가능성 관점에서 비효율적입니다.

우리의 목표는 **"무료/제한된 쿼터 자원을 극대화하여 활용하면서도, 단 한 번의 HTTP 429 에러도 사용자 경험으로 이어지지 않게 만드는 시스템"**을 구축하는 것이었습니다.

---

## 2. Trade-off: 가용성 확보를 위한 아키텍처 선택

외부 API 제약을 극복하기 위해 세 가지 대안을 검토했습니다.

| 구분 | Option A: 단순 지연 재시도 (Exponential Backoff) | Option B: 라운드 로빈 (Round Robin) | Option C: 계층형 폴백 체인 (Tiered Fallback Chain) [선택] |
| :--- | :--- | :--- | :--- |
| **방식** | 429 발생 시 일정 시간 대기 후 재시도 | 여러 모델에 요청을 균등 분산 | 쿼터가 많고 빠른 모델 우선 소모 후, 차선책 모델로 릴레이 호출 |
| **장점** | 구현이 매우 단순함 | 특정 모델에 부하가 집중되지 않음 | **최대 가용성 보장, 자원 효율성 극대화** |
| **단점** | 대기 시간 동안 유저 Latency 급증 | 낮은 쿼터의 고성능 모델 쿼터가 조기 소진됨 | 모델별 쿼터 및 가용 상태 추적 로직 필요 |

**결정: Option C (계층형 폴백 체인)**

사용자 경험(Latency)을 보장하면서 자원 사용 효율을 극대화하기 위해 **4단계 순차 연동 파이프라인**을 도입했습니다.

1. **1순위 (Primary)**: `Gemini 3.1 Flash-Lite` (높은 쿼터, 빠른 응답)
2. **2순위 (Secondary)**: `Gemini 3.5 Flash-Lite` (1순위 소진 시 폴백)
3. **3순위 (Tertiary)**: `Gemini 3.5 Flash` (하위 모델 한도 초과 시 차선책)
4. **4순위 (Quaternary)**: `Gemini 3.6 Flash` (최종 보루)

---

## 3. Engineering Implementation: 회복 탄력성과 가시성 확보

### (1) Resilient Fallback Relay Logic
FastAPI 기반 백엔드 서비스 내에서 4단계 모델 후보군을 순차적으로 탐색하며, 예외 발생 시 다음 모델로 즉시 넘어가도록 결합도를 낮춘 파이프라인을 구축했습니다.

```python
# ocr_service.py (개념적 재구성 코드)
class GeminiOCRService:
    def __init__(self):
        # 쿼터 효율성 기준 4단계 폴백 체인 정의
        self.model_candidates = [
            "gemini-3.1-flash-lite",
            "gemini-3.5-flash-lite",
            "gemini-3.5-flash",
            "gemini-3.6-flash"
        ]

    async def extract_text_with_fallback(self, image_bytes: bytes) -> OCRResult:
        last_exception = None
        
        for model_name in self.model_candidates:
            # 실시간 Quota 상태 체크
            if not await self._has_remaining_quota(model_name):
                continue
                
            try:
                result = await self._call_gemini_api(model_name, image_bytes)
                await self._decrement_quota(model_name)
                return result
                
            except RateLimitException as e:
                # HTTP 429 감지 시 다음 차선책 모델로 즉시 무중단 이행
                logger.warning(f"Rate limit hit for {model_name}, falling back to next candidate.")
                last_exception = e
            except Exception as e:
                logger.error(f"Unexpected error on {model_name}: {str(e)}")
                last_exception = e
                
        raise ServiceUnavailableException("All OCR fallback models exhausted.") from last_exception
```

### (2) Non-blocking Parallel Benchmarking (`asyncio.gather`)
어드민 환경에서 Gemini 4개 모델과 외부 OCR 엔진(Naver Clova OCR) **총 5개 모델의 정확도와 Latency를 동시에 실시간 비교**해야 했습니다. 

동기식 호출 방식을 사용할 경우 전체 응답 시간이 N배로 증가하기 때문에, `asyncio.gather`를 활용해 이벤트 루프 블로킹 없이 병렬로 성능 벤치마크를 수행하도록 최적화했습니다.

```python
# admin.py (개념적 재구성 코드)
@router.post("/admin/ocr-compare/run")
async def run_ocr_benchmark(image_payload: ImagePayload):
    engines = [
        gemini_service.call("gemini-3.1-flash-lite", image_payload),
        gemini_service.call("gemini-3.5-flash-lite", image_payload),
        gemini_service.call("gemini-3.5-flash", image_payload),
        gemini_service.call("gemini-3.6-flash", image_payload),
        clova_service.call_ocr(image_payload)
    ]
    
    # 5개 OCR 엔진을 동기 블로킹 없이 병렬 실행
    results = await asyncio.gather(*engines, return_exceptions=True)
    
    return process_benchmark_metrics(results)
```

### (3) Dynamic Observability Dashboard
아키텍처 변경에 맞추어 어드민 모니터링 시스템을 개편했습니다. 각 모델의 **실시간 사용량, 남은 쿼터, RPM, 평균 지연시간(Latency)**을 시각화하여, 운영팀이 파이프라인의 건강 상태를 한눈에 파악하고 쿼터 고갈 임계치를 사전에 감지할 수 있도록 보완했습니다.

---

## 4. Takeaway: 무엇을 얻고 배웠는가?

1. **무중단 가용성(High Availability) 확보**:
   특정 외부 AI 모델에 장애가 발생하거나 Rate Limit에 도달해도, 유저는 이를 인식하지 못한 채 100% 정상적인 OCR 결과를 응답받게 되었습니다.
2. **비용 효율적인 자원 배분 (Quota Optimization)**:
   Lite 모델을 1/2순위에 배치하여 일일 1,000회 이상의 기본 쿼터를 안정적으로 확보하였고, 상대적으로 쿼터가 희소한 상위 모델을 아껴서 사용할 수 있게 되었습니다.
3. **데이터 기반 아키텍처 개선 (Observability)**:
   5개 엔진에 대한 동시 비동기 벤치마크 데이터를 실시간 수집함으로써, 향후 트래픽 증가 시 어떤 엔진을 메인 파이프라인으로 올릴지에 대한 확실한 엔지니어링 근거(Latency vs Accuracy)를 마련했습니다.

---

### 💡 에디터의 한 줄 요약
> **"외부 의존성(Third-party API)은 언제든 실패할 수 있다."**  
> 이번 개선을 통해 외부 API의 불확실성을 소프트웨어 아키텍처(Fallback Pattern + Async Parallelization)로 유연하게 제어하는 결함 허용(Fault Tolerant) 시스템을 구축할 수 있었습니다.