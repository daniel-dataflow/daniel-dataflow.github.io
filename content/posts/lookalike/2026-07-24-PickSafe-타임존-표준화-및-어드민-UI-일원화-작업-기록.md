---
title: "PickSafe 타임존 표준화 및 어드민 UI 일원화 작업 기록"
date: "2026-07-24 09:00:00"
category: "PickSafe"
tags: ["Timezone", "FastAPI", "SQLAlchemy", "React", "아키텍처", "최적화", "회고"]
---

화장품 성분 분석 서비스 PickSafe를 개발하고 운용하면서, 최근 서버 및 데이터베이스의 타임존 불일치로 인한 데이터 표기 오류와 어드민 UI 파편화 문제를 해결했습니다. 

클라우드 인프라의 기본 설정값과 실제 서비스 제공 지역 간의 시간 차이에서 비롯된 문제점들을 정리하고, 이를 백엔드와 프론트엔드 전반에서 어떻게 구조적으로 일원화했는지 기술적 기록으로 남깁니다.

---

## 🎯 마주한 고민과 문제 배경

PickSafe 백엔드는 Render 플랫폼에 호스팅되어 있으며, 데이터베이스로는 Neon DB(PostgreSQL)를 사용하고 있습니다. 두 인프라 모두 기본 시스템 타임존이 **UTC(협정 세계시, +00:00)**로 설정되어 있습니다.

서비스를 운영하는 과정에서 이 인프라 타임존과 서비스 주요 타깃 지역(KST, +09:00) 간의 간극으로 인해 몇 가지 명확한 문제가 발생했습니다.

1. **사용자 경험 저해 및 데이터 불일치**
   - 사용자가 한국 시간 기준으로 오후 2시(14:00 KST)에 화장품 성분 스캔을 완료했으나, 데이터베이스와 API 직렬화 과정에서 UTC 기준 시간인 오전 5시(05:00 UTC)로 처리되는 현상이 있었습니다.
   - 이로 인해 마이페이지의 스캔 이력이나 어드민 로그 화면에서 "어제 스캔한 기록"으로 잘못 표기되거나, 혼란스러운 시각이 노출되었습니다.

2. **배치 스케줄러 실행 시점과 서버 부하**
   - 식약처 성분 공공데이터를 매일 최신화하는 수집 배치 스케줄러가 UTC 기준 자정(00:00 UTC)에 실행되도록 설정되어 있었습니다.
   - 이는 한국 시간으로 **오전 9시(09:00 KST)**에 해당하며, 출근 시간대 사용자의 성분 검색 트래픽과 스케줄러 부하가 겹치면서 DB CPU 점유율이 순간적으로 치솟는 위험이 있었습니다.

3. **어드민 UI/UX의 파편화**
   - 어드민 페이지 내 각 모듈(성분 수집, 번역 관리, CAS 번호 자동 보강 내역, 1:1 문의 등)마다 날짜 표기 방식이 제각각이었습니다.
   - 어떤 화면은 ISO-8601 원문(`2026-07-16T05:00:00Z`), 어떤 화면은 `YYYY-MM-DD HH:MM`, 다른 화면은 상대 시간("3시간 전") 형태로 노출되어 관리 작업 시 시각적 피로도가 컸습니다.

---

## ⚖️ 기술적 대안 비교 및 선택 이유

시간 정합성을 확보하기 위해 백엔드, DB, 프론트엔드 영역에서 적용 가능한 대안들을 비교했습니다.

| 구분 | 대안 A: DB 서버 타임존을 KST로 변경 | 대안 B: 클라이언트(웹) 단에서만 시간 변환 | 대안 C: DB는 UTC 유지 + 백엔드 직렬화 Layer에서 KST 변환 강제 (최종 선택) |
| :--- | :--- | :--- | :--- |
| **장점** | SQL 쿼리 처리 시 즉시 KST 시간 사용 가능 | 서버 측 로직 변경 최소화 | DB 데이터 표준화(UTC) 유지, 백엔드/어드민/스케줄러 전체 정합성 보장 |
| **단점** | 클라우드 매니지드 DB 재부팅/마이그레이션 시 설정 유실 위험, 글로벌 확장 시 유연성 저하 | API 응답 데이터 원본이 UTC라 렌더링 주체마다 변환 로직 중복 구현 필요 | API 응답 직렬화 및 Helper 함수 일관 도입 필요 |
| **선택 여부** | 미선택 | 미선택 | **선택** |

### 선택 이유
DB 인스턴스의 타임존을 직접 KST로 지정하는 방식(대안 A)은 관리가 복잡해지고, 향후 글로벌 인프라 확장 시 안 좋은 패턴이 될 수 있습니다. 또한 클라이언트에만 변환을 맡기는 방식(대안 B)은 스케줄러 타임존 문제나 CSV/엑셀 다운로드 등의 어드민 백엔드 생성 데이터에 대한 해결책이 되지 못했습니다.

따라서 **"DB 저장 시에는 표준 UTC(`func.now()`)를 유지하되, 백엔드 API 직렬화 레이어와 스케줄러 트리거 시점, 그리고 프론트엔드 포맷터를 KST 기준으로 명시적 일원화하는 방식(대안 C)"**을 선택했습니다.

---

## 🏗️ 시스템 아키텍처 및 흐름

전체 시스템에서 데이터가 저장되고, 백엔드 헬퍼를 거쳐 KST 표준 시간 및 통일된 어드민 UI로 표현되는 데이터 흐름은 다음과 같습니다.

```mermaid
graph TD
    subgraph Client ["Client Layer (React Admin / Web UI)"]
        A["User / Admin Action"]
        B["Unified UI Display ('오늘 14:30', 'YYYY-MM-DD HH:MM:SS')"]
    end

    subgraph Backend ["Backend Layer (FastAPI)"]
        C["API Endpoint"]
        D["KST Helper (_KST = timezone(hours=9))"]
        E["MFDS Batch Scheduler (Explicit KST 00:00)"]
    end

    subgraph Database ["Database Layer (Neon DB)"]
        F[("PostgreSQL (Stored in UTC via func.now())")]
    end

    A -->|Request Scan / Fetch Admin Log| C
    C -->|Query Data| F
    F -->|UTC Datetime Raw Data| C
    C -->|Serialize via .astimezone(_KST)| D
    D -->|KST JSON Response| B
    E -->|Triggered at KST Midnight| F
```

---

## 💻 핵심 구현 및 트러블슈팅

### 1. 백엔드 KST 타임존 변환 표준 헬퍼 구현

Python 백엔드 전역에서 일관되게 사용할 타임존 상수를 정의하고, SQLAlchemy 엔티티를 Pydantic Schema나 DTO로 변환할 때 안전하게 KST로 변환해 주는 헬퍼 함수를 구축했습니다.

```python
# app/core/timezone.py
from datetime import datetime, timezone, timedelta

# KST 타임존 상수 정의 (+09:00)
_KST = timezone(timedelta(hours=9))

def to_kst_datetime(dt: datetime | None) -> datetime | None:
    """
    Naive 또는 UTC Datetime 객체를 입력받아 KST Datetime으로 변환합니다.
    """
    if dt is None:
        return None
    
    # timezone 정보가 없는 Naive datetime인 경우 UTC로 간주
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
        
    return dt.astimezone(_KST)

def format_kst(dt: datetime | None, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """
    Datetime 객체를 KST 기준 포맷 스트링으로 반환합니다.
    """
    kst_dt = to_kst_datetime(dt)
    if kst_dt is None:
        return ""
    return kst_dt.strftime(fmt)
```

### 2. 트러블슈팅: Naive Datetime과 Aware Datetime의 혼용 예외

초기 구현 시 DB에서 조회한 `datetime` 객체 일부가 `tzinfo`가 없는 Naive 객체로 넘어와 `astimezone()` 호출 시 시차가 잘못 계산되는 버그가 있었습니다.

- **원인**: PostgreSQL `TIMESTAMP WITHOUT TIME ZONE` 컬럼 조회 시 Python SQLAlchemy 모델에서 `tzinfo`가 `None`으로 매핑됨.
- **해결**: `to_kst_datetime` 헬퍼 내부에서 `if dt.tzinfo is None:` 조건을 두어 기본 축을 UTC(`timezone.utc`)로 명시적으로 부여(replace)한 뒤 `astimezone(_KST)`를 적용하도록 방어 로직을 구현했습니다.

### 3. 배치 스케줄러 실행 시점 교정

식약처 공공데이터 수집 스케줄러의 실행 시점을 KST 자정으로 명확히 지정하여 사용자 서비스 요청 시간대와의 스케줄링 충돌을 제거했습니다.

```python
# app/scheduler/jobs.py
from apscheduler.schedulers.background import BackgroundScheduler
from app.core.timezone import _KST

scheduler = BackgroundScheduler(timezone=_KST)

# KST 기준 매일 00:05분에 식약처 수집 작업 실행
scheduler.add_job(
    func=sync_mfds_ingredients,
    trigger="cron",
    hour=0,
    minute=5,
    id="mfds_sync_job"
)
```

### 4. 어드민 디자인 시스템 및 시간 포맷터 통일

어드민 UI 디자인 시스템 리팩토링 과정에서 각 테이블과 대시보드 카드에 적용되던 날짜/시간 포맷터를 일원화했습니다.

```typescript
// admin/src/utils/formatDate.ts
export const formatKstTime = (dateString: string | null): string => {
  if (!dateString) return "-";

  const date = new Date(dateString);
  const now = new Date();

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  // 당일 발생 기록은 '오늘 14:30' 형태, 이전 기록은 'MM.DD HH:mm' 형태로 통일
  if (isToday) {
    return `오늘 ${hours}:${minutes}`;
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${month}.${day} ${hours}:${minutes}`;
};
```

어드민 사이드바 및 대시보드의 아이콘 세트와 CAS 번호 자동 보강 작업 테이블 UI도 함께 정리하여 시각적 직관성을 향상시켰습니다.

---

## 💡 돌아보며 배운 점 (회고)

이번 타임존 표준화 및 어드민 UI 일원화 작업을 마치며 얻은 주요 기술적 레슨은 다음과 같습니다.

1. **타임존 문제는 초기 아키텍처 규칙 정의가 핵심이다**
   서비스 초기 단계에서 DB, 백엔드 직렬화, 프론트엔드 디스플레이 간의 타임존 교환 규약을 엄격히 정해두지 않으면, 데이터가 누적될수록 사용자 경험과 시스템 스케줄링 전체에 은밀한 버그를 야기한다는 점을 다시금 확인했습니다.

2. **인프라 설정에 의존하지 않는 명시적 코드의 중요성**
   클라우드 호스팅 환경(Render, Neon)의 기본 설정(UTC)을 억지로 변경하려 하기보다, 데이터 저장은 UTC라는 글로벌 표준을 따르고 비즈니스 경계 레이어에서 `_KST` 변환을 명시적 코드로 처리함으로써 인프라 이전이나 환경 변화에도 영향받지 않는 단단한 구조를 만들 수 있었습니다.

3. **운영 도구(Admin) 가시성의 중요성**
   어드민 UI의 날짜 포맷과 아이콘 파편화를 정리함으로 인해 배치 작업 실패 로그나 성분 데이터 수집 현황을 파악하는 속도가 크게 개선되었습니다. 관리자 도구의 일관성 역시 전체 서비스 안정성을 지탱하는 중요한 요소임을 깨달았습니다.

추후 서비스 대상 국가가 확장될 경우, 이번에 구축한 백엔드 타임존 헬퍼 레이어를 기반으로 사용자별 로컬 타임존 지원(Dynamic Client Timezone) 구조로 유연하게 확장해 나갈 계획입니다.