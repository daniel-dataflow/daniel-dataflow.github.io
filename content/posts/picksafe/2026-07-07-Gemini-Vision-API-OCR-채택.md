---
title: "비정형 데이터와의 싸움: Gemini Vision API를 활용한 가성비 있고 견고한 OCR 파이프라인 구축기"
category: "PickSafe"
date: "2026-07-07 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "LLM", "OCR"]
---

안녕하세요, PickSafe 개발 팀입니다. 

PickSafe 서비스의 핵심 기능 중 하나는 사용자가 업로드한 화장품 성분표 이미지를 빠르고 정확하게 분석하여 안전성 정보를 제공하는 것입니다. 하지만 전 세계의 수많은 화장품 성분표는 줄바꿈, 쉼표, 특수문자, 그리고 영어와 한국어가 복잡하게 뒤섞인 대표적인 **'비정형 데이터'**입니다. 

초기 MVP 단계에서 제한된 자원으로 어떻게 이 복잡한 이미지 데이터를 정확하게 텍스트로 디지털화할 수 있었는지, 그리고 개발 생산성을 지키기 위해 아키텍처 관점에서 어떤 트레이드오프(Trade-off)를 거쳤는지 공유하고자 합니다.

---

## 1. 우리가 마주한 문제 (Problem)

화장품 성분표 이미지를 텍스트로 변환하는 작업은 생각보다 까다롭습니다. 

1. **도메인 특화 용어의 한계**: 성분명은 "에틸헥실글리세린(Ethylhexylglycerin)"과 같이 길고 복잡한 화학 용어가 많습니다. 일반적인 OCR은 철자 하나만 틀려도 완전히 다른 성분으로 인식하거나 분석에 실패합니다.
2. **복잡한 비정형 레이아웃**: 둥근 용기 표면에 인쇄된 텍스트, 줄바꿈의 모호함, 다국어 병기 등으로 인해 텍스트 영역을 올바르게 구획화(Segmentation)하기 어렵습니다.
3. **비용과 성능의 딜레마**: 상용 클라우드 OCR API(Google Cloud Vision, AWS Textract 등)는 훌륭한 대안이지만, 트래픽을 예측할 수 없는 MVP 단계에서 비용 부담이 큽니다. 반면, 오픈소스 OCR(Tesseract 등)은 무료이지만 비정형 다국어 인식률이 현저히 떨어졌습니다.

---

## 2. 기술적 고민과 대안 비교 (Trade-off)

성분표 OCR 엔진 후보군을 두고 우리 팀은 성능, 비용, 개발 용이성 관점에서 아래와 같이 비교 분석을 진행했습니다.

| 비교 군 | 인식 정확도 (다국어/도메인 용어) | 도입 및 운영 비용 | 개발 편의성 및 유연성 |
| :--- | :--- | :--- | :--- |
| **A. 오픈소스 OCR (Tesseract)** | ❌ 낮음 (복잡한 레이아웃에서 인식률 저하) | 🟢 매우 낮음 (자체 호스팅) | 🟡 보통 (이미지 전처리 파이프라인 추가 필요) |
| **B. 상용 Cloud OCR (AWS, Google 등)** | 🟡 보통~높음 (글자 자체는 잘 읽으나 문맥 이해 부족) | ❌ 높음 (호출당 과금) | 🟢 좋음 (안정적인 API) |
| **C. Gemini Vision API (Free Tier)** | 🟢 **매우 높음 (LLM 기반 문맥 복원 가능)** | 🟢 **매우 낮음 (무료 티어 한도 내 활용)** | 🟢 **매우 좋음 (프롬프트로 결과 제어 가능)** |

### 선택: Gemini Vision API

우리 팀은 최종적으로 **Gemini Vision API**를 핵심 엔진으로 채택했습니다. 
그 이유는 단순히 글자를 읽는 것(OCR)을 넘어, **LLM이 가진 문맥 이해 능력을 결합할 수 있기 때문**이었습니다. 일부 글자가 깨지거나 가려져 있더라도, 앞뒤 문맥을 통해 "에틸헥실글리세린"이라는 정확한 화학 성분명을 유추해 내는 능력이 압도적으로 뛰어났습니다. 또한, MVP 단계에서 무료 티어 한도 내에서 비용 부담 없이 시작할 수 있다는 점도 매력적이었습니다.

---

## 3. 아키텍처 설계와 의사결정: "개발 환경의 걸림돌 제거하기"

Gemini Vision API 도입을 결정했지만, 또 다른 엔지니어링 장벽이 있었습니다.

* 외부 API 의존성으로 인해, 로컬 개발 환경이나 CI/CD 파이프라인에서 API 키가 없거나 Rate Limit(호출 제한)에 도달하면 전체 애플리케이션의 런타임 에러로 이어질 수 있었습니다.
* 개발자 개개인이 로컬 테스트를 할 때마다 아까운 API 호출 할당량을 소모해야 했습니다.

이 문제를 해결하기 위해, 우리는 **'인터페이스 추상화'**와 **'Mock 디버그 폴백(Fallback) 모드'**를 아키텍처에 이식했습니다.

### 우아한 열화(Graceful Degradation)를 고려한 구현 패턴

```python
# web/backend/app/services/ocr_service.py (구조 이해를 돕기 위한 예시 코드)

import logging
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)

class OCRService(ABC):
    @abstractmethod
    async def extract_ingredients(self, image_bytes: bytes) -> list[str]:
        pass

class GeminiOCRService(OCRService):
    def __init__(self, api_key: str | None):
        self.api_key = api_key

    async def extract_ingredients(self, image_bytes: bytes) -> list[str]:
        # API 키가 없는 경우, 런타임 에러를 내는 대신 Mock 폴백 모드로 동작
        if not self.api_key:
            logger.warning("[OCR] Gemini API Key가 설정되지 않았습니다. Mock 디버그 모드로 동작합니다.")
            return self._get_mock_data()
        
        try:
            # 실제 Gemini Vision API 호출 및 비정형 텍스트 추출 로직 수행
            return await self._call_gemini_api(image_bytes)
        except Exception as e:
            logger.error(f"[OCR] API 호출 중 오류 발생: {e}. 폴백 데이터를 반환합니다.")
            return self._get_mock_data()

    def _call_gemini_api(self, image_bytes: bytes) -> list[str]:
        # 실제 API 연동 로직 (보안상 상세 구현 생략)
        return ["정제수", "글리세린", "부틸렌글라이콜"]

    def _get_mock_data(self) -> list[str]:
        # 개발 환경용 미리 정의된 테스트 데이터
        return ["정제수", "글리세린", "병풀추출물(Mock)"]
```

이 구조 덕분에 우리 팀은 다음과 같은 이점을 얻을 수 있었습니다.

1. **높은 결합도 제거 (Decoupling)**: 비즈니스 로직은 `OCRService` 인터페이스에만 의존하므로, 향후 더 나은 OCR 엔진이 나오더라도 서비스 코드의 변경 없이 엔진만 교체할 수 있습니다.
2. **끊김 없는 개발 경험 (DX, Developer Experience)**: 새로 합류한 개발자가 API 키 설정을 깜빡하더라도, 로컬 서버는 에러 없이 실행되며 Mock 성분 데이터를 반환해 줍니다. 개발 흐름이 막히는 병목을 제거한 것입니다.

---

## 4. 엔지니어링 교훈 (Takeaways)

이번 OCR 파이프라인 구축을 통해 우리 팀이 배운 교훈은 명확합니다.

* **기술 선택은 현재의 제약 조건에 맞춰 최적화해야 합니다.** 초기 MVP 단계에서는 무조건 거대하고 비싼 솔루션을 도입하기보다, 비용 효율적이면서도 비정형 데이터 처리 성능이 극대화된 Gemini 무료 티어와 같은 대안을 스마트하게 활용하는 지혜가 필요합니다.
* **외부 의존성은 언제나 깨질 수 있음을 대비해야 합니다.** API 키 누락, 네트워크 단절, Rate Limit 초과 등 외부 서비스는 언제든 실패할 수 있습니다. 시스템 설계 시 '우아한 열화(Graceful Degradation)'와 '디버그 폴백'을 고려하는 것이 프로덕션 레벨의 견고함을 만듭니다.

PickSafe 팀은 단순히 동작하는 코드를 넘어, 팀원 모두가 스트레스 없이 개발할 수 있는 아키텍처와 사용자에게 안정적인 서비스를 제공할 수 있는 견고함을 늘 고민하고 있습니다. 앞으로 더 큰 트래픽을 감당하기 위해 이 파이프라인을 어떻게 고도화해 나갈지, 다음 여정도 기대해 주세요!