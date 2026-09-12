---
title: "무료 티어의 한계를 넘는 고가용성 OCR 파이프라인: Gemini 4단계 Fallback Chain과 비동기 벤치마크 구축기"
category: "PickSafe"
date: "2026-07-23 09:00:00"
tags: ["Architecture", "FastAPI", "FallbackStrategy", "Observability", "AsyncIO"]
---

외부 API에 의존하는 서비스를 운영하다 보면 피할 수 없는 난관이 있습니다. 바로 **Rate Limit(호출 제한)**과 **가용성(Availability) 문제**입니다. 특히 화장품 성분표를 실시간으로 인식하는 OCR 서비스처럼 텍스트 추출 정확도와 서비스 응답 속도가 모두 중요한 유저 도메인에서는, 외부 API의 429(Too Many Requests) 에러나 단일 모델 장애가 곧바로 유저 이탈로 이어집니다.

이번 포스팅에서는 제한된 외부 API 쿼터를 극적으로 효율화하고, 단일 점 장애(SPOF)를 방지하기 위해 설계한 **'Gemini 4단계 순차 연동(Fallback Chain)'**과 **'FastAPI 비동기 병렬 벤치마크 엔진'** 도입기를 공유합니다.

---

## 1. 문제 정의: "단일 모델 의존성과 429 Rate Limit의 벽"

PickSafe 서비스의 화장품 성분 스캔 기능은 이미지에서 텍스트를 정밀하게 추출해야 합니다. 초기 파이프라인은 단일 멀티모달 LLM API에 의존하고 있었습니다. 그러나 서비스 이용자가 늘어남에 따라 두 가지 큰 병목이 발생했습니다.

1. **Rate Limit(429 Error)으로 인한 요청 실패**: 무료 티어 및 제한된 쿼터 환경에서 순간적인 트래픽 몰림이나 일일 쿼터(RPD) 소진 시 유저 스캔 요청이 그대로 실패 처리되었습니다.
2. **운영 가시성 결여**: 현재 어떤 모델의 쿼터가 얼마나 남았는지, latency(지연 시간)가 얼마나 발생하는지 실시간으로 추적할 수 없어 장애 사전 대응이 불가능했습니다.
3. **상용 API 대조의 어려움**: Naver Clova OCR과 같은 유료 전용 OCR 엔진과 LLM 기반 Vision 모델 간의 비용 대비 성능을 객관적으로 실시간 대조할 수 있는 벤치마크 체계가 부재했습니다.

---

## 2. 기술적 고민과 대안 비교 (Trade-offs)

단일 API 한계를 극복하기 위해 기술 검토를 진행하며 두 가지 대안을 대조했습니다.

### 대안 A: 단순 라운드 로빈(Round-Robin) 또는 랜덤 분산
- **장점**: 구현이 단순하고 트래픽을 균등하게 분산시킬 수 있음.
- **단점**: 각 모델마다 일일 쿼터(RPD)와 분당 요청 수(RPM) 차이가 큼에도 불구하고 이를 고려하지 못함. 쿼터가 적은 고성능 모델의 쿼터가 먼저 마르고 나면 파이프라인 전체가 불안정해짐.

### 대안 B: 쿼터 기반 우회 우선순위 계층(Cascading Fallback Chain) [최종 선택]
- **장점**: 
  - 쿼터가 넉넉하고 가벼운 Lite 모델을 최우선 소모하고, 상위 Flash 모델을 후순위 안전망으로 배치하여 **비용 효율성과 가용성을 동시에 달성**.
  - 앞선 단계에서 429 에러나 Timeout 발생 시 유저가 에러를 겪지 않고 즉시 다음 순위 모델로 자동 우회(Failover).
- **단점**:
  - 순차 fallback 시 지연 시간이 누적될 수 있음 -> *타임아웃 핸들링 및 상태 모니터링으로 극복 필요.*

 우리는 **대안 B**를 채택하여, 각 모델의 RPD/RPM 정책에 맞춘 **4단계 Fallback Chain**을 구축하기로 결정했습니다.

---

## 3. 해결책: 고가용성 아키텍처 및 실시간 모니터링 구축

### (1) Gemini 4단계 Fallback Chain 아키텍처

우선순위는 **"일일 쿼터 한도가 높은 모델 우선 소모"** 및 **"비용/가용성 최적화"**를 기준으로 설계했습니다.

```
[유저 스캔 요청]
       │
       ▼
[1순위] Gemini 3.1 Flash-Lite (RPD 500 / RPM 15) ──(성공)──> [결과 반환]
       │ (429 Error / Timeout)
       ▼
[2순위] Gemini 3.5 Flash-Lite (RPD 500 / RPM 15) ──(성공)──> [결과 반환]
       │ (429 Error / Timeout)
       ▼
[3순위] Gemini 3.5 Flash      (RPD  20 / RPM  5) ──(성공)──> [결과 반환]
       │ (429 Error / Timeout)
       ▼
[4순위] Gemini 3.6 Flash      (RPD  20 / RPM  5) ──(성공)──> [결과 반환]
       │ (전체 실패 시)
       ▼
[최종 예외 처리 및 Fallback Alert]
```

백엔드 파이프라인 서비스(Python/FastAPI) 내부에서는 모델 후보군(`model_candidates`)을 순회하며 비동기 호출을 시도하고, 특정 모델이 실패할 경우 카운터를 차감(Decrement)하며 다음 모델로 즉시 제어권을 넘깁니다.

```python
# 서비스 레이어 아키텍처 의사 코드 (보안 처리됨)
class ResilientOCRService:
    def __init__(self):
        self.model_chain = [
            "gemini-3.1-flash-lite", # 1순위: 주력 (High Quota)
            "gemini-3.5-flash-lite", # 2순위: 차선책 (High Quota)
            "gemini-3.5-flash",      # 3순위: 백업 (Low Quota)
            "gemini-3.6-flash"       # 4순위: 최후의 보루 (Low Quota)
        ]

    async def execute_ocr_with_fallback(self, image_bytes: bytes) -> OCRResponse:
        last_exception = None
        for model_name in self.model_chain:
            if not await self._check_quota_available(model_name):
                continue
                
            try:
                # API 호출 및 지연시간 측정
                result = await self._call_ocr_api(model_name, image_bytes)
                await self._update_metrics(model_name, success=True)
                return result
            except RateLimitException:
                # 429 에러 발생 시 쿼터 차감 및 즉시 다음 모델로 Fallback
                await self._decrement_quota(model_name)
                continue
            except Exception as e:
                last_exception = e
                continue
                
        raise OCRPipelineFailedException("모든 Fallback 모델 소진") from last_exception
```

### (2) `asyncio.gather` 기반 5개 엔진 병렬 벤치마크

어드민 영역에서는 4개의 Gemini 모델과 Naver Clova OCR을 포함한 **총 5개 엔진**의 성능(추출 정확도, Latency)을 실시간 대조해야 했습니다. 

동기(Blocking) 방식으로 5개 API를 호출하면 전체 측정 시간이 각 API 응답 시간의 합만큼 늘어납니다. 이를 해결하기 위해 FastAPI의 비동기 I/O 장점을 극대화하여 `asyncio.gather` 기반의 **Non-blocking 병렬 비교 엔진**을 구축했습니다.

```python
# 어드민 벤치마크 API 엔드포인트 핵심 구조
@router.post("/admin/ocr-compare/run")
async def run_ocr_benchmark(image_file: UploadFile):
    engines = [
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
        "clova-ocr"
    ]
    
    # 5개 엔진을 동시 병렬 실행 (가장 느린 API 응답 시간만큼만 소요)
    tasks = [request_ocr_engine_metric(engine, image_file) for engine in engines]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    return process_benchmark_results(results)
```

이 구조를 통해 어드민 페이지에서는 블로킹 없이 약 **1~2초 내외로 5개 API의 Latency 및 쿼터 잔여량을 동시에 실시간 추적**할 수 있게 되었습니다.

---

## 4. 엔지니어링 교훈 및 성과 (Takeaways)

### 📈 비즈니스 & 아키텍처적 성과
1. **서비스 SLA(상태 가용성) 극대화**: 특정 Gemini 모델에 429 에러가 발생해도 유저는 장애를 전혀 인지하지 못하고 100% 정상적으로 스캔 결과를 수신하게 되었습니다.
2. **비용 효율적인 무료 티어 운용**: 일일 500회 소모 가능한 Lite 모델 2종을 선제적으로 활용함으로써, 유료 클라우드 비용 지출을 최소화하면서 안정성을 확보했습니다.
3. **운영 가시성(Observability) 확보**: 어드민 대시보드를 통해 실시간 RPM, 남은 Quota, 모델별 Latency를 한눈에 파악하여, 차후 트래픽 증가 시 어떤 인프라 쿼터를 확장해야 할지 데이터 기반의 의사결정이 가능해졌습니다.

### 💡 엔지니어링 Lesson Learned
- **외부 API는 언제든 실패할 수 있다**: 외부 종속성이 있는 핵심 기능은 'Happy Path'만 고려해선 안 됩니다. 반드시 Graceful Degradation(단계적 기능 축소 및 우회) 파이프라인을 설계해야 합니다.
- **비동기 IO를 활용한 Observability 구축**: 모니터링 장치가 메인 비즈니스 로직에 부하를 주어선 안 됩니다. Python의 `asyncio` 병렬 처리를 적극 활용하여 시스템 성능 저하 없이 밀도 높은 운영 메트릭을 수집할 수 있었습니다.