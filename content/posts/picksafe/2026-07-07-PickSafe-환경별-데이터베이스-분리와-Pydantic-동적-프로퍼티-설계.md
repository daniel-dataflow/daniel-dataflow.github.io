---
title: "PickSafe 환경별 데이터베이스 분리와 Pydantic 동적 프로퍼티 설계"
date: "2026-07-07 09:00:00"
category: "PickSafe"
tags: ["FastAPI", "Pydantic", "PostgreSQL", "Neon", "아키텍처", "회고"]
---

화장품 성분 분석 서비스인 PickSafe를 개발하며 성분 DB 구조를 잡고 API를 확정해 나가는 과정에서 데이터베이스 관리 방식에 대한 기술적 수정을 진행했습니다. 

초기에는 개발 편의성을 위해 단일 데이터베이스 연결 문자열(`DATABASE_URL`)을 공유하는 방식을 취했습니다. 하지만 성분 데이터의 파싱 및 시드(Seed) 데이터 주입 테스트가 빈번해짐에 따라 운영 데이터가 오염될 위험이 커졌고, 이를 구조적으로 해결할 필요성을 느꼈습니다. 이번 글에서는 개발 및 운영 데이터베이스 격리 과정에서 마주했던 고민과, 기존 코드의 변경을 최소화하면서 이를 안전하게 분리한 방식을 기록합니다.

---

## 🎯 마주한 고민과 문제 배경

PickSafe는 수만 개에 달하는 화장품 성분 및 원료 데이터를 다루다 보니, 로컬 환경에서 파싱 스크립트를 실행하거나 스키마 마이그레이션(Alembic)을 테스트하는 일이 자주 발생합니다. 기존에는 하나의 `.env` 파일에 단일 `DATABASE_URL`만 등록해 두고 사용했습니다.

이 방식은 시간이 지나면서 몇 가지 심각한 문제를 야기했습니다.

1. **테스트 데이터와 운영 데이터의 혼재**: 성분 정제 로직 테스트 중 생성된 임시 데이터나 깨진 데이터가 운영 환경의 레코드와 섞일 위험이 존재했습니다.
2. **휴먼 에러 가능성**: 배포 시점에 환경 변수를 수동으로 교체하다가 실수로 개발용 DB URL을 상용 환경에 배포하거나, 반대로 로컬에서 상용 DB에 직접 쿼리를 날릴 위험이 있었습니다.
3. **Neon Postgres 서버리스 인스턴스의 한계**: PickSafe는 클라우드 Postgres 서비스로 Neon을 활용하고 있습니다. Free Tier 특성상 연산 유닛(CU)과 스토리지 용량 제약이 존재하기 때문에, 트래픽이 발생하는 운영 DB와 개발/테스트용 DB의 컴퓨팅 자원을 명확히 분리할 필요가 있었습니다.

---

## ⚖️ 기술적 대안 비교 및 선택 이유

환경 구분을 위해 몇 가지 접근 방식을 비교 검토했습니다.

| 구분 | 대안 A: `.env.dev`, `.env.prod` 파일 분리 | 대안 B: Pydantic Settings 내부 동적 프로퍼티 활용 |
| :--- | :--- | :--- |
| **작동 방식** | 실행 환경에 따라 적절한 `.env` 파일을 로드하도록 파이프라인 구성 | 하나의 설정 클래스에서 `ENV` 값에 따라 URL을 동적으로 분기 |
| **장점** | 표준적인 환경변수 파일 분리 방식 | 데이터베이스 참조 코드(`database.py`)의 수정이 불필요하며 응집도가 높음 |
| **단점** | CI/CD 및 배포 환경마다 실행 파라미터나 환경변수 주입 스크립트 관리 필요 | 설정 클래스 내부에 약간의 분기 로직 포함 |
| **안전성** | 파일 지정 누락 시 설정 미적용 위험 존재 | `ENV` 미지정 시 기본값(`dev`)으로 안전하게 폴백(Fallback) 가능 |

대안 A 방식은 배포 스크립트나 컨테이너 빌드 시 파일 경로가 틀어질 위험이 있었습니다. 따라서 애플리케이션 설정 체계 내부에서 분기 처리하는 **대안 B**를 선택했습니다.

`.env` 파일에 `DEV_DATABASE_URL`과 `PROD_DATABASE_URL`을 모두 정의해 두고, `ENV` 환경 변수값(`prod` 또는 `dev`)에 따라 `@property`를 통해 적절한 URL을 동적으로 반환하도록 설계했습니다.

---

## 🏗️ 시스템 아키텍처 및 흐름

수정된 설계를 통해 애플리케이션 레이어와 실제 연결되는 데이터베이스 사이의 연결 흐름을 다이어그램으로 나타내면 다음과 같습니다.

```mermaid
flowchart TD
    subgraph EnvConfig ["Environment Variables (.env / OS)"]
        ENV["ENV ('dev' / 'prod')"]
        DEV_URL["DEV_DATABASE_URL"]
        PROD_URL["PROD_DATABASE_URL"]
    end

    subgraph AppCore ["PickSafe Application Core"]
        Config["app/config.py (Settings Class)"]
        DBEngine["app/database.py (SQLAlchemy Engine)"]
    end

    subgraph NeonCloud ["Neon Postgres Clusters"]
        DevDB[("PickSafe Dev DB")]
        ProdDB[("PickSafe Prod DB")]
    end

    ENV --> Config
    DEV_URL --> Config
    PROD_URL --> Config

    Config -- "settings.DATABASE_URL (Property)" --> DBEngine

    DBEngine -- "ENV == 'prod'" --> ProdDB
    DBEngine -- "ENV != 'prod' (Default: dev)" --> DevDB
```

`database.py` 등의 하위 모듈은 변경 이전과 동일하게 `settings.DATABASE_URL`만을 참조하므로, 데이터베이스 연결을 생성하는 기존 비즈니스 로직에 영향을 주지 않습니다.

---

## 💻 핵심 구현 및 트러블슈팅

### 1. `app/config.py` 구현

Pydantic `BaseSettings`를 활용하여 환경 변수를 검증하고, `@property` 구문으로 분기 로직을 구현했습니다. 민감한 데이터베이스 접속 비밀번호는 추상화하여 관리하도록 작성했습니다.

```python
import os
from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # 실행 환경 구분 (기본값: dev)
    ENV: Literal["dev", "prod"] = "dev"
    
    # 개별 데이터베이스 URL 정의
    DEV_DATABASE_URL: str = "postgresql+psycopg2://user:SETTINGS.KEY@dev-db.neon.tech/picksafe_dev"
    PROD_DATABASE_URL: str = "postgresql+psycopg2://user:SETTINGS.KEY@prod-db.neon.tech/picksafe_prod"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    @property
    def DATABASE_URL(self) -> str:
        """
        ENV 환경 변수에 따라 적절한 DB 연결 문자열을 동적으로 반환합니다.
        명시적으로 'prod'로 설정되지 않은 모든 경우 안전하게 DEV_DATABASE_URL을 바라봅니다.
        """
        if self.ENV == "prod":
            return self.PROD_DATABASE_URL
        return self.DEV_DATABASE_URL

settings = Settings()
```

### 2. 하위 모듈와의 디커플링 (`app/database.py`)

`app/database.py`에서는 설정의 변경 유무와 관계없이 기존과 완벽히 동일한 방식으로 엔진을 생성합니다.

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings

# settings.DATABASE_URL 호출 시 @property에 의해 분기된 URL이 들어옴
engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
```

### 💡 트러블슈팅: Alembic 마이그레이션 환경 설정

구조 변경 후 Alembic 마이그레이션을 실행할 때, `env.py`가 기존 `.env` 파일의 정적 `DATABASE_URL`을 찾지 못해 마이그레이션이 실패하는 문제가 있었습니다.

이를 해결하기 위해 `alembic/env.py`에서도 애플리케이션의 `settings` 객체를 직접 가져와 URL을 주입하도록 수정했습니다.

```python
# alembic/env.py 내용 일부
from app.config import settings
from app.database import Base  # ORM 모델 MetaData

# alembic.ini의 sqlalchemy.url을 config.py의 동적 프로퍼티로 덮어씀
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
```

이 처리를 통해 로컬 개발 환경에서 `alembic upgrade head` 명령을 실행하면 안전하게 개발용 DB에만 마이그레이션이 적용되고, 운영 배포 파이프라인에서 `ENV=prod` 상태로 실행될 때만 상용 DB 스키마가 업데이트되도록 고쳤습니다.

---

## 💡 돌아보며 배운 점 (회고)

단순한 데이터베이스 URL 분기 작업이었지만, 이 결정을 내리고 구현하면서 몇 가지 중요한 점을 배웠습니다.

1. **인터페이스 호환성의 중요성**: `settings.DATABASE_URL`이라는 접근 방식을 유지한 덕분에 데이터베이스 세션을 다루는 수많은 코드 영역을 단 한 줄도 수정하지 않고 안전하게 설계를 변경할 수 있었습니다. Pydantic의 `@property` 기능을 잘 활용한 덕분이었습니다.
2. **안전한 기본값(Fail-Safe) 설정**: `ENV` 설정값이 누락되거나 잘못 입력되었을 때 상용 DB가 아닌 개발 DB를 가리키도록 기본값을 `dev`로 고정한 점은 휴먼 에러를 막는 강력한 안전장치가 되었습니다.
3. **자원 효율성**: Neon의 개발용 DB와 상용 DB를 완전히 격리함으로써 테스트 중 발생할 수 있는 잠재적 데드락이나 용량 낭비가 운영 서비스의 슬로우 쿼리로 이어지는 리스크를 제거했습니다.

추후에는 애플리케이션 시작 시점에 `ENV=prod`임에도 불구하고 DB URL이 정상적으로 로드되지 않았을 경우, 앱 구동을 즉시 중단(Fail-Fast) 시키는 유효성 검사 구문을 추가하여 안정성을 더욱 보완해 볼 계획입니다.