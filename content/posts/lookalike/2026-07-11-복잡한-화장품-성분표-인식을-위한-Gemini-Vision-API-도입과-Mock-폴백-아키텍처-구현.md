---
title: "복잡한 화장품 성분표 인식을 위한 Gemini Vision API 도입과 Mock 폴백 아키텍처 구현"
date: "2026-07-11 09:00:00"
category: "PickSafe"
tags: ["PickSafe", "GeminiAPI", "OCR", "FastAPI", "아키텍처", "최적화", "회고"]
adr_source: "docs/decisions/2026-07/2026-07-07-Gemini-Vision-API-OCR-채택.md"
original_adr_date: "2026-07-07"
---

화장품 성분 분석 서비스 **PickSafe**를 개발하면서 가장 먼저 마주한 큰 장벽은 '사용자가 촬영한 성분표 이미지에서 어떻게 정확하게 텍스트를 추출할 것인가'였습니다. 

화장품 패키징의 성분표 텍스트는 폰트 크기가 매우 작고, 미세한 조명 반사나 곡면 굴곡이 빈번하며, 국문과 영문 성분명이 쉼표(,) 및 특수문자와 얽혀 있는 전형적인 비정형 데이터입니다. 초기 설계 단계에서 발생한 추출 명확성 문제와 이를 해결하기 위해 Gemini Vision API를 파이프라인에 이식하고 디버그 폴백 모드를 구축한 과정에 대해 기록합니다.

---

## 🎯 마주한 고민과 문제 배경

초기에는 가장 접근하기 쉬운 오픈소스 OCR 라이브러리인 Tesseract나 EasyOCR을 활용해 파이프라인을 구축하려 했습니다. 그러나 실제 화장품 성분표 이미지를 적용해보았을 때 몇 가지 치명적인 한계가 드러났습니다.

1. **문맥 파악 불가로 인한 단어 파편화**: 성분표는 '병풀추출물', '글리세린', '부틸렌글라이콜'과 같이 특정 화학/식물 명칭이 연달아 나열됩니다. 전통적인 OCR 솔루션은 문자 경계 인식 실패 시 단어를 엉뚱하게 쪼개거나 쉼표를 오인식하여 분석 파이프라인 전체에 잘못된 데이터를 전달했습니다.
2. **다국어 혼용 및 줄바꿈 처리의 어려움**: 한국어 성분명 옆에 괄호로 표기된 영문 성분명(INCI)이나 특수 기호가 섞여 있을 때, 텍스트의 읽기 순서(Reading Order)가 꼬이는 문제가 자주 발생했습니다.
3. **개발 환경에서의 안정성 확보**: 외부 클라우드 Vision API를 도입할 경우, 로컬 테스트나 CI 환경에서 매번 API를 호출하게 되면 비용 문제와 함께 Rate Limit(호출 제한) 오류로 인해 테스트가 중단되는 현상이 발생할 수 있었습니다.

따라서 단순 이미지 인식(OCR)을 넘어 **문맥을 이해하는 Vision LLM Engine**을 파이프라인에 도입하되, 개발 및 테스트 환경에서 흔들리지 않는 **안정적인 폴백(Fallback) 모드**를 함께 설계해야 했습니다.

---

## ⚖️ 기술적 대안 비교 및 선택 이유

성분표 텍스트 추출 엔진 선정을 위해 대안들을 비교 검토했습니다.

| 항목 | Tesseract / EasyOCR | Enterprise Cloud OCR (GCP Vision / AWS Textract) | Gemini Vision API (Free Tier) |
| :--- | :--- | :--- | :--- |
| **성분 텍스트 인식률** | 낮음 (경계 분리 오류 빈번) | 보통 (텍스트 추출은 우수하나 구조화 필요) | **매우 높음** (문맥 기반 복원 우수) |
| **전처리/후처리 공수** | 높음 (Bounding Box, Regex 후처리 필수) | 보통 (좌표 기반 정렬 로직 필요) | **낮음** (프롬프트 제어로 쉼표 구분 텍스트 반환) |
| **비용 (초기 MVP 기준)**| 무제한 (자체 서버 자원 사용) | 사용량에 비례하여 과금 발생 | **무료 티어 활용 가능** |
| **결합도 및 유연성** | C++ 의존성 / 딥러닝 모델 탑재 필요 | 클라우드 SDK 결합 | REST / Google GenAI SDK 단순 호출 |

### 선택 이유
Gemini Vision API는 텍스트 단순 인식을 넘어 **화장품 성분표라는 도메인 맥락을 이해하고 출력 포맷을 제어**할 수 있다는 결정적인 장점이 있었습니다. "이미지에 포함된 화장품 성분명만 쉼표로 구분하여 추출하라"는 프롬프트를 처리하는 능력이 기존 Enterprise OCR의 bounding box 후처리 로직보다 훨씬 높은 정밀도를 보여주었습니다.

또한 MVP 수준에서는 Gemini API의 Free Tier 범위 내에서 충분히 서비스 검증이 가능하다고 판단했습니다. 다만, API 키가 미설정되어 있거나 Rate Limit에 도달했을 때 전체 백엔드 시스템이 멈추는 것을 방지하기 위해 **Mock 디버그 폴백(Fallback) 구조**를 필수적으로 병행 구축하기로 결정했습니다.

---

## 🏗️ 시스템 아키텍처 및 흐름

전체 성분 분석 파이프라인에서 `ocr_service.py`가 위치한 계층과 디버그 폴백 동작 흐름은 다음과 같습니다.

```mermaid
flowchart TD
    subgraph ClientLayer ["Client"]
        A["App / Web User"]
    end

    subgraph BackendCore ["FastAPI Backend Environment"]
        B["app/api/v1/scan.py"]
        C["app/services/ocr_service.py"]
        D["app/config.py (Settings)"]
    end

    subgraph ExternalServices ["External & Fallback Engine"]
        E["Gemini Vision API (Free Tier)"]
        F["Mock Debug Engine (Local Pre-defined Ingredients)"]
    end

    A -->|1. 성분표 이미지 업로드| B
    B -->|2. 이미지 전달| C
    C <-->|3. GEMINI_API_KEY 검증| D
    
    C -- "4a. 키 유효 & Quota 정상" --> E
    C -- "4b. 키 부재 또는 Error/Rate Limit" --> F
    
    E -->|5a. 성분 텍스트 반환| C
    F -->|5b. 디버그 텍스트 반환 (Warn Log)| C
    
    C -->|6. 정제된 텍스트 전달| B
    B -->|7. 위험도 분석 파이프라인 연결| B
```

---

## 💻 핵심 구현 및 트러블슈팅

### 1. 추상화된 OCR 서비스 및 Mock 폴백 구현 (`ocr_service.py`)

서비스 모듈 내부에서 API 키 존재 유무와 런타임 예외를 감지하여 유연하게 Mock 모드로 전환되도록 작성했습니다. 

```python
# app/services/ocr_service.py
import logging
import google.generativeai as genai
from PIL import Image
from io import BytesIO
from app.config import settings

logger = logging.getLogger(__name__)

# API 키가 제공되지 않을 경우를 위한 기본 Mock 성분 데이터
MOCK_INGREDIENTS_FALLBACK = (
    "정제수, 글리세린, 부틸렌글라이콜, 1,2-헥산다이올, 병풀추출물, "
    "소듐하이알루로네이트, 카보머, 트로메타민, 에틸헥실글리세린, 디소듐이디티에이"
)

def initialize_gemini():
    """Gemini Client 초기화 설정"""
    api_key = getattr(settings, "GEMINI_API_KEY", None)
    if api_key and api_key != "YOUR_GEMINI_API_KEY_HERE":
        genai.configure(api_key=api_key)
        return True
    return False

async def extract_ingredients_from_image(image_bytes: bytes) -> str:
    """
    업로드된 이미지 바이트를 입력받아 성분표 텍스트를 추출합니다.
    API 키 미설정 또는 런타임 오류 발생 시 Mock 데이터를 반환합니다.
    """
    is_gemini_ready = initialize_gemini()

    if not is_gemini_ready:
        logger.warning(
            "[OCR_SERVICE] GEMINI_API_KEY가 설정되지 않았습니다. Mock 폴백 모드로 동작합니다."
        )
        return MOCK_INGREDIENTS_FALLBACK

    try:
        image = Image.open(BytesIO(image_bytes))
        model = genai.GenerativeModel("gemini-1.5-flash")

        prompt = (
            "이 화장품 성분표 이미지에서 성분명만 추출해 주세요. "
            "부가적인 설명 없이, 각 성분을 쉼표(,)로만 구분한 단일 텍스트 문자열로 응답하세요. "
            "인식하기 어려운 문자는 주변 맥락을 통해 올바른 화장품 성분명으로 복원하세요."
        )

        response = model.generate_content([prompt, image])
        
        if response.text:
            extracted_text = response.text.strip()
            logger.info("[OCR_SERVICE] Gemini Vision API 호출 성공")
            return extracted_text
        else:
            raise ValueError("Gemini API로부터 빈 응답을 받았습니다.")

    except Exception as e:
        logger.error(f"[OCR_SERVICE] Vision API 처리 중 오류 발생: {str(e)}. Mock 모드로 전환합니다.")
        return MOCK_INGREDIENTS_FALLBACK
```

---

### 🚨 구현 중 마주친 이슈와 트러블슈팅

#### 이슈: Gemini 응답 내 마크다운 및 서술형 텍스트 포함 현상
초기 프롬프트 사용 시 Gemini가 다음과 같이 응답에 마크다운 포맷이나 인사말을 포함하는 현상이 있었습니다.

```text
```text
정제수, 글리세린, 부틸렌글라이콜...
```
이 추출된 성분 목록입니다.
```

이로 인해 다음 단계인 `성분 파싱 및 위험도 분석 엔진`으로 문자열이 넘어갈 때 Parsing Error가 발생했습니다.

#### 해결 과정
1. **System Instruction 및 프롬프트 명확화**: 프롬프트에 `부가적인 설명 없이` 및 `단일 텍스트 문자열로 응답`하라는 제약 조건을 강력하게 명시했습니다.
2. **코드 레벨 정제 로직 추가**: 프롬프트 제어 외에도 백엔드 코드에서 마크다운 블록 기호(```` ``` ````)나 개행 문자를 사전에 제거하는 방어적인 정규식 후처리 함수를 추가하여 데이터 신뢰성을 확보했습니다.

```python
import re

def clean_extracted_text(text: str) -> str:
    """LLM 응답 텍스트에서 불필요한 마크다운 코드 블록 및 개행 제거"""
    cleaned = re.sub(r"```[a-zA-Z]*", "", text)
    cleaned = cleaned.replace("```", "").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned
```

---

## 💡 돌아보며 배운 점 (회고)

이번 작업을 진행하며 기술 선택과 파이프라인 설계에 대해 크게 세 가지를 돌아보게 되었습니다.

1. **전통적 OCR 대안으로서의 Vision LLM의 가치**
   단순 패턴 인식 기반의 OCR은 폰트 변형이나 잡음에 취약하고 후처리 로직(Regex/Bounding Box 연산)에 많은 공수가 들어갑니다. 도메인 특화 용어가 많은 데이터를 다룰 때는 Vision LLM을 활용해 문맥 복원까지 한 번에 처리하는 것이 개발 속도와 정확도 측면에서 훨씬 유리함을 체감했습니다.

2. **개발 경험(DX)을 고려한 폴백 시스템 구축의 중요성**
   외부 API 의존도가 높은 기능을 개발할 때, API 키가 없거나 네트워킹이 단절된 로컬 환경에서도 전체 시스템이 작동할 수 있도록 `Mock Fallback Engine`을 초기에 구축한 것은 매우 유효한 결정이었습니다. 덕분에 다른 도메인 로직(성분 분석, 위험도 계산 등)을 개발할 때 API 호출 실패나 과금 걱정 없이 독립적인 테스팅을 진행할 수 있었습니다.

3. **향후 보완할 점**
   현재 구현은 이미지 전체를 그대로 API에 전달하는 형태입니다. 사용자가 고해상도 이미지를 전송할 경우 네트워크 래턴시가 증가하는 현상이 있었습니다. 추후에는 클라이언트 측(또는 API 게이트웨이 전단)에서 이미지 리사이징 및 압축 전처리를 추가하여 레이턴시와 대역폭 사용량을 한층 더 최적화할 계획입니다.