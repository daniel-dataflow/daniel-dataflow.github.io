---
title: "비정형 성분표 이미지 인식의 한계 극복하기: Vision LLM 도입과 Graceful Fallback 아키텍처 설계"
category: "PickSafe"
date: "2026-07-07 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "Gemini", "Backend"]
---

제품 실물 이미지를 촬영하여 성분을 분석하는 서비스를 개발할 때 가장 먼저 마주치는 거대한 장벽은 **"어떻게 비정형 텍스트를 정확하게 추출할 것인가"**입니다. 

화장품 성분표는 곡면 용기, 조명 반사, 복잡한 줄바꿈, 콤마(,) 구분의 유무, 그리고 다국어(영어/한국어)와 화학 명칭이 뒤섞여 있는 대표적인 비정형 데이터입니다. 

PickSafe 팀이 이 문제를 해결하기 위해 전통적인 OCR 방식 대신 **Vision LLM(Gemini Vision API)**을 선택한 이유와, 이 과정에서 발생할 수 있는 런타임 장애 및 개발 병목을 방지하기 위해 구축한 **Mock 디버그 폴백(Fallback) 구조**를 공유합니다.

---

## 1. 문제 정의: 단순 텍스트 인식을 넘어선 '문맥의 이해' 필요성

초기 기술 검토 단계에서 우리는 화장품 성분표 추출을 위해 일반적인 오픈소스 OCR(Tesseract 등) 및 전통적 클라우드 Vision API를 실험했습니다. 그러나 다음과 같은 명확한 문제점들에 직면했습니다.

1. **곡면 및 노이즈에 대한 약한 내구성**: 용기의 굴곡이나 촬영 각도에 따라 글자가 찌그러지면 인식률이 급격히 떨어졌습니다.
2. **도메인 특화 용어의 훼손**: `Niacinamide`(나이아신아마이드), `Centella Asiatica`(병풀추출물) 같은 전문 화학/성분 명칭은 스펠링 한두 개만 틀려도 DB 매칭에 실패합니다. 기존 OCR은 오타를 그대로 출력하지만, 이를 교정하는 후처리 파이프라인을 만드는 것은 배보다 배꼽이 더 컸습니다.
3. **구조화의 어려움**: 단순 텍스트 덩어리(Raw Text)만 반환하는 기존 OCR 시스템으로는 성분과 성분 사이의 구분자(콤마, 줄바꿈, 특수문자)를 정확히 파악하여 배열(Array)화하기 어려웠습니다.

우리에겐 **"단순히 글자를 읽는 엔진"**이 아니라, **"오타를 문맥으로 복원하고 구조화할 수 있는 엔진"**이 필요했습니다.

---

## 2. 기술적 고민과 대안 비교 (Trade-offs)

비정형 성분표 추출 파이프라인 구성을 위해 3가지 대안을 비교·검토했습니다.

| 비교 항목 | 대안 A: 오픈소스 OCR (Tesseract) | 대안 B: 상용 Cloud OCR (AWS/Google) | 대안 C: LLM 기반 Vision API (Gemini Vision) |
| :--- | :--- | :--- | :--- |
| **성분 텍스트 인식률** | 낮음 (노이즈 및 곡면에 취약) | 보통~높음 (텍스트 자체는 잘 읽음) | **매우 높음** (불완전한 문맥 복원 가능) |
| **데이터 구조화** | 불가능 (별도 룰베이스 파서 구현 필요) | 제한적 (Bounding Box 기반) | **최상** (텍스트 추출과 동시에 파싱 가능) |
| **비용 (MVP 단계)** | 무료 (인프라 호스팅 비용 발생) | 즉시 유료 (호출당 과금) | **무료 티어 활용 가능** (초기 인프라 비용 절감) |
| **처리 속도** | 빠름 | 빠름 | 보통 (인퍼런스 지연 존재) |

### 💡 최종 선택: Gemini Vision API (Free Tier)
우리는 **Gemini Vision API**를 최종 엔진으로 채택했습니다. 
LLM 기반 Vision 모델은 이미지 속의 오탈자나 일부 훼손된 성분명을 자체적인 언어 맥락(Context)으로 유추하여 정확한 성분명으로 복원해 내는 독보적인 장점이 있었습니다. 또한, 초기 MVP 검증 단계에서 비용 부담 없이 Free Tier 한도 내에서 운영할 수 있다는 점도 비즈니스적으로 큰 이점이었습니다.

---

## 3. 엔지니어링 과제: 외부 API 의존성과 개발 생산성 격리

Vision LLM API 도입은 훌륭한 정확도를 가져다주었지만, 시스템 관점에서는 두 가지 새로운 위험 요소를 반입했습니다.

1. **개발 환경의 API Key 의존성**: 새로 합류한 개발자나 CI/CD 환경에서 API Key가 세팅되지 않았을 때 서비스 로직이 붕괴될 위험.
2. **Rate Limit 및 외부 장애 팩터**: API 호당 제한 초과(Rate Limit)나 외부 서비스 장애 시 백엔드 전체로 장애가 전파될 가능성.

### 🛠️ 해결책: Graceful Fallback & Mock Debug Mode

우리는 `OCRService` 레이어를 추상화하여, **유효한 API 키의 유무와 런타임 상태에 따라 Graceful하게 반응하는 구조**를 설계했습니다.

```python
# 서비스 레이어 아키텍처 콘셉트 (보안을 위해 추상화된 코드)
import logging
from typing import List

logger = logging.getLogger(__name__)

class OCRService:
    def __init__(self, api_key: str | None):
        self.api_key = api_key
        self.is_mock_mode = not bool(api_key)
        
        if self.is_mock_mode:
            logger.warning("[OCRService] GEMINI_API_KEY 미설정: Mock 디버그 모드로 동작합니다.")

    async def extract_ingredients(self, image_bytes: bytes) -> List[str]:
        # 1. API 키가 없거나 디버그 모드인 경우 Mock 데이터 반환 (시스템 다운 방지)
        if self.is_mock_mode:
            return self._get_mock_fallback_data()

        # 2. 실제 Vision API 호출 파이프라인
        try:
            return await self._call_vision_api(image_bytes)
        except Exception as e:
            logger.error(f"[OCRService] Vision API 호출 실패, Fallback 작동: {str(e)}")
            # API 호출 실패 시에도 서비스 런타임 crash를 막고 안전하게 Fallback 처리
            return self._get_mock_fallback_data()

    def _get_mock_fallback_data(self) -> List[str]:
        """개발/테스트용 표준 화장품 성분 샘플 반환"""
        return ["Water", "Glycerin", "Niacinamide", "Centella Asiatica Extract"]
```

이 구조를 통해 이뤄낸 시스템적 이점은 다음과 같습니다.

- **개발 생산성(DX) 향상**: 로컬 환경에서 외부 API Key 발급 없이도 프론트엔드-백엔드 연동 테스트를 즉시 진행할 수 있습니다.
- **시스템 복원력(Resilience) 확보**: 외부 API의 Rate Limit이 발생하거나 네트워킹 장애가 생겨도 백엔드 애플리케이션이 `500 Internal Server Error`로 뻗지 않고 대응 가능한 상위 레이어로 예외 상황을 안전하게 전달합니다.

---

## 4. 엔지니어링 교훈 (Takeaways)

1. **"픽셀 매칭"보다 "맥락 이해"가 우선이다**
   도메인 특화 데이터(성분표, 약학 정보 등)를 다룰 때는 단순 OCR의 인지 성능보다, 훼손된 데이터를 복원해 내는 LLM의 문맥 이해 능력이 파이프라인 전체의 품질을 결정짓는 핵심 요소였습니다.

2. **외부 API 채택 시 'Graceful Degradation'은 필수다**
   아무리 성능이 뛰어난 AI API라도 외부 서비스는 언제든 실패할 수 있습니다. 시스템 초기 설계 단계부터 API 누락이나 호스트 장애를 고려한 Mock/Fallback 경로를 만들어 두는 것이 전체 팀의 개발 속도와 시스템 안정성을 보장합니다.

3. **비용 체계에 맞춘 유연한 아키텍처 설계**
   MVP 단계에서는 Free Tier를 적극 활용하되, 서비스 확장에 따라 언제든지 다른 Commercial OCR이나 자체 구축 모델로 전환할 수 있도록 인터페이스를 추상화(`ocr_service.py`)해 두는 것이 현명한 시스템 설계임을 재확인했습니다.

---

PickSafe 팀은 사용자에게 더 빠르고 정확한 성분 분석 경험을 제공하기 위해, AI 기술 도입과 시스템 아키텍처의 견고함 사이에서 끊임없이 최선의 Trade-off를 고민하고 있습니다.