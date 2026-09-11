---
title: "무료 티어 한계 속에서 99.9% 가용성 확보하기: Gemini OCR 4단계 Fallback Chain과 비동기 벤치마크 시스템 구축기"
category: "PickSafe"
date: "2026-07-23 09:00:00"
tags: ["Architecture", "Resilience", "FastAPI", "AsyncIO", "Troubleshooting"]
---

화장품 성분 분석 서비스 **PickSafe**의 핵심 기능은 사용자가 촬영한 성분표 이미지에서 텍스트를 정확하게 추출하는 **OCR 파이프라인**입니다. 

스타트업 초기 단계에서는 비전 LLM(Vision LLM) 모델의 높은 OCR 인식률과 비용 효율성을 활용하기 위해 외부 API(Gemini 등)의 무료 티어를 적극 활용하게 됩니다. 하지만 외부 의존성이 높아질수록 **"API Rate Limit(HTTP 429 Too Many Requests)으로 인한 서비스 중단 위험"**이라는 치명적인 아킬레스건을 마주하게 됩니다.

이번 글에서는 PickSafe 팀이 **단일 API의 한계를 극복하기 위해 구축한 4단계 Fallback Chain 구조**와, 파이프라인의 성능 및 정밀도를 실시간으로 관측할 수 있도록 구현한 **비동기 벤치마킹 시스템**의 엔지니어링 과정을 소개합니다.

---

## 1. 문제 정의: 외부 API 제한과 서비스 연속성의 충돌

PickSafe의 스캔 요청이 증가함에 따라, 단일 AI 모델 API에 의존하던 기존 구조에서 다음과 같은 명확한 문제점들이 드러났습니다.

1. **Strict Rate Limit (HTTP 429) 장애**: 특정 Gemini 모델의 무료 티어 제한(RPM: 분당 요청 수, RPD: 일일 요청 수)을 초과하는 순간, 사용자 스캔 요청이 즉각 실패했습니다.
2. **비용 및 쿼터 불균형**: 쿼터 여유가 있는 가벼운 모델(Lite 계열)과 쿼터는 적지만 성능이 뛰어난 모델(Flash 계열)이 혼재되어 있었으나, 이를 효율적으로 분배하는 제어 레이어가 없었습니다.
3. **블라인드 스폿(Visibility 부재)**: 각 API의 실시간 Latency, 남은 쿼터, 모델별 OCR 추출 정밀도를 한눈에 대조하고 모니터링할 도구가 부재하여, 문제 발생 시 즉각적인 원인 파악이 어려웠습니다.

우리의 목표는 **"비용을 최소화(무료 쿼터 극대화)하면서도, 사용자에게 단 한 번의 스캔 실패도 제공하지 않는 탄력적인(Resilient) 시스템"**을 만드는 것이었습니다.

---

## 2. 기술적 고민과 대안 비교 (Trade-off Analysis)

이 문제를 해결하기 위해 엔지니어링 팀은 세 가지 접근 방식을 검토했습니다.

| 대안 | 장점 | 단점 / 한계 | 선택 여부 |
| :--- | :--- | :--- | :--- |
| **A. 유료 플랜 단순 전환** | 구현이 매우 단순함 | 초기 유저 확보 단계에서 불필요한 고정 비용 발생 및 외부 장애(Outage) 자체는 방지 불가능 | 미선택 |
| **B. 모델 간 라운드로빈 / 로드밸런싱** | 모든 모델의 트래픽을 균등하게 분산 | 쿼터 소모 속도가 제각각(일 500회 vs 일 20회)인 상황에서 낮은 쿼터 모델이 먼저 고갈됨 | 미선택 |
| **C. 쿼터 기반 순차 릴레이 (Fallback Chain)** | 비용 최적화(Lite 우선) 및 가용성 극대화(최대 4단계 안전망) | 1~2순위 실패 시 Tail Latency(지연 시간)가 누적될 수 있음 | **최종 선택** |

### 선택과 타협 (Trade-off)
우리는 **C안(Fallback Chain)**을 선택했습니다. 1순위 모델 요청이 실패할 경우 다음 순위 모델로 전환되는 과정에서 약간의 추가 지연시간(Latency)이 발생할 수 있지만, **"서비스 불능(Failure)보다 지연된 성공(Degraded Success)이 100배 낫다"**는 가용성 우선 원칙을 적용했습니다.

---

## 3. Architecture & Implementation

### (1) Gemini OCR 4단계 순차 연동 (Fallback Chain)

API 쿼터 한도와 성능 지표를 바탕으로 우선순위를 정렬한 4단계 자동 릴레이 호출 구조를 구현했습니다.

```
[사용자 OCR 스캔 요청]
         │
         ▼
[1순위: Gemini 3.1 Flash-Lite] (일 500회 / 15 RPM) ──(성공)──> [결과 반환]
         │ (Rate Limit / 실패)
         ▼
[2순위: Gemini 3.5 Flash-Lite] (일 500회 / 15 RPM) ──(성공)──> [결과 반환]
         │ (Rate Limit / 실패)
         ▼
[3순위: Gemini 3.5 Flash]      (일 20회  / 5 RPM)  ──(성공)──> [결과 반환]
         │ (Rate Limit / 실패)
         ▼
[4순위: Gemini 3.6 Flash]      (일 20회  / 5 RPM)  ──(성공)──> [결과 반환]
         │ (최종 실패)
         ▼
[예외 처리 및 Fallback Error 응답]
```

* **전략의 핵심**: daily quota가 500회로 넉넉한 **Flash-Lite 모델을 최전방에 배치**하여 대다수의 트래픽을 처리하고, 쿼터가 적은(일 20회) **상위 Flash 모델은 비상용 레스큐(Rescue) 모델로 아껴두는 구조**입니다.

백엔드 레벨에서는 단일 서비스 레이어(`ocr_service.py`) 내에서 후보 모델 배열을 순회하며, Exception 발생 시 다음 후보로 유연하게 핸드오버되도록 스위칭 로직을 추상화했습니다.

### (2) `asyncio.gather` 기반 5개 OCR 엔진 병렬 벤치마킹

Fallback Chain 구조를 안정적으로 운용하려면 "각 모델의 실제 정확도와 속도"를 끊임없이 검증해야 합니다. 이를 위해 어드민 영역에 **5개 OCR 엔진(Gemini 4종 + Naver Clova OCR)을 동시에 비교하는 벤치마킹 파이프라인**을 구축했습니다.

이때 핵심은 백엔드 이벤트 루프를 블로킹하지 않고 동시성을 극대화하는 것이었습니다. Python의 `asyncio.gather`를 활용해 5개 외부 API 호출을 동시 병렬 실행하도록 구현했습니다.

```python
# [개념 코드] 5개 OCR 엔진 동시 병렬 성능 비교 (보안 마스킹 처리됨)
import asyncio
from typing import List, Dict, Any

async def run_ocr_benchmark(image_bytes: bytes) -> List[Dict[str, Any]]:
    # 벤치마크 대상 5개 엔진 태스크 생성
    tasks = [
        call_gemini_ocr(image_bytes, model_version="3.1-flash-lite"),
        call_gemini_ocr(image_bytes, model_version="3.5-flash-lite"),
        call_gemini_ocr(image_bytes, model_version="3.5-flash"),
        call_gemini_ocr(image_bytes, model_version="3.6-flash"),
        call_clova_ocr(image_bytes),
    ]
    
    # asyncio.gather를 통한 비동기 병렬 실행 (Non-blocking)
    # return_exceptions=True를 통해 특정 API 실패가 전체 벤치마크를 중단하지 않도록 보호
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    return process_benchmark_metrics(results)
```

이 구조 덕분에 개별 엔진 호출 시 발생하는 Latency 합산이 아닌, **가장 느린 API의 응답 시간 내에 5개 엔진의 비교 데이터(Latency, Quota, Accuracy)를 통합 수집**할 수 있게 되었습니다.

### (3) 실시간 쿼터 & 인프라 모니터링 (Observability)

어드민 모니터링 Dashboard를 개편하여 각 모델별로 **[사용량 / 남은 쿼터 / 현재 RPM / 평균 Latency]**를 실시간 추적하도록 메트릭 파이프라인을 확장했습니다. 

이를 통해 특정 모델의 쿼터가 고갈 직전에 도달하거나 장애가 발생하는 상황을 운용팀이 미리 인지하고 선제 대응할 수 있는 가시성을 확보했습니다.

---

## 4. Key Takeaways (엔지니어링 레슨)

이번 아키텍처 개편을 통해 PickSafe 팀이 얻은 핵심 레슨은 다음과 같습니다.

1. **외부 의존성에 대한 'Design for Failure' 원칙**
   외부 제3자(Third-party) API는 언제든 실패하거나 제한될 수 있습니다. 시스템 아키텍처는 이를 '특이 상태'가 아닌 **'언제든 일어날 수 있는 일반적 상태'**로 받아들이고,  graceful degradation(단계적 기능 저하) 및 Fallback 메커니즘을 내재화해야 합니다.

2. **비동기 I/O(Async I/O)를 활용한 진단 도구의 효율화**
   `asyncio.gather`를 적극 활용하여 벤치마킹 시스템 구축 시 메인 서버 자원에 부담을 주지 않으면서도 동시 다발적인 외부 API 검증 환경을 효율적으로 구현할 수 있었습니다.

3. **비용 효율성과 가용성의 균형점 도출**
   무작정 고비용 플랜을 채택하기보다, 무료 티어의 제약 조건(RPM/RPD)을 면밀히 분석하여 라우팅 우선순위를 정교하게 설계함으로써 **운영 비용 0원 유지와 무장애 서비스 가용성**이라는 두 마리 토끼를 모두 잡을 수 있었습니다.

---

### 마치며
외부 API 제약 조건 속에서 안정적인 서비스를 제공하는 것은 모든 현대적 웹 애플리케이션의 공통 과제입니다. PickSafe 팀은 앞으로도 철저한 관측 가능성(Observability)과 탄력적인 아키텍처를 기반으로 사용자에게 끊김 없는 최상의 경험을 제공해 나갈 것입니다.