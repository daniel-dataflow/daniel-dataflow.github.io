---
title: "Neon DB 쿼터 초과 장애를 방지하는 DW Failover 구축과 데이터 아키텍처 재설계"
date: "2026-08-20 09:00:00"
category: "PickSafe"
tags: ["Database", "Failover", "SystemArchitecture", "Refactoring", "DataIntegrity"]
---

화장품 성분 분석 서비스인 PickSafe를 개발하고 운영하면서, 최근 인프라 안정성 측면에서 뼈아픈 장애를 마주했습니다. 분석용 데이터를 적재하는 Neon DB의 Compute 및 Network 쿼터가 일시적으로 초과되면서, 데이터 웨어하우스(DW) DB로의 접근이 완전히 차단되는 현상이 발생한 것입니다. 

처음에는 단순히 예비 DB를 하나 더 파이프라인에 붙여 우회(Failover)하는 방식으로 쉽게 해결할 수 있을 것이라 생각했습니다. 하지만 우회 시스템을 설계하고 코드를 뜯어보는 과정에서, 기존 데이터 모델링에 내재되어 있던 더 심각한 아키텍처적 결함을 발견했습니다. 

장애를 극복하기 위해 수행했던 DW Failover 구축 과정과, 근본적인 데이터 정합성을 해결하기 위해 데이터 아키텍처를 재설계한 기록을 담담히 복기해 보고자 합니다.

---

## 🎯 마주한 고민과 문제 배경

Neon DB의 프리 티어(Free Tier) 및 저비용 요금제는 사용량 제한(Quota)이 엄격합니다. 대량의 화장품 성분 수집 및 분석 배치가 돌면서 일시적으로 이 한계를 초과했고, DW DB가 잠기는 현상이 발생했습니다. 

이를 해결하기 위해 메인 DW 외에 예비 DW 프로젝트를 추가로 생성하고, 메인 DW 장애 발생 시 예비 DW로 커넥션을 우회하는 자동 Failover 시스템을 설계하기 시작했습니다. 그러나 구현 도중 두 가지의 중대한 설계 오류를 발견했습니다.

### 1. DW DB 내에 상태(State) 데이터가 혼재되어 있었던 문제
식약처 자동 수집 스케줄러의 예약 상태를 관리하는 `seeding_schedule_settings` 테이블이 메인 운영 DB가 아닌 DW DB에 위치하고 있었습니다. 
만약 메인 DW가 차단되어 예비 DW로 커넥션을 우회하면, 예비 DW에는 이 예약 설정 데이터가 존재하지 않으므로 크론잡(Cron Job)이 오작동하거나 예약이 초기화되는 치명적인 상태 불일치가 발생할 수밖에 없는 구조였습니다.

### 2. 성분 마스터 데이터의 불필요한 이중화
성분 분석의 기준이 되는 `ingredients_master` 테이블이 메인 DB와 DW DB 양쪽에 모두 존재하며 이중화되어 있었습니다. 
DB 이중화 동기화가 완벽히 보장되지 않는 상황에서 예비 DW로 커넥션이 넘어가게 되면, 기존 DW와 예비 DW 간의 마스터 데이터 정합성이 깨져 사용자에게 잘못된 성분 분석 결과를 보여줄 위험이 있었습니다.

---

## ⚖️ 기술적 대안 비교 및 선택 이유

문제를 해결하기 위해 크게 두 가지 대안을 두고 저울질했습니다.

| 비교 항목 | 대안 1: DW DB 간 실시간 동기화 및 복제 | 대안 2: 상태/마스터 데이터 메인 DB 이관 및 DW 역할 축소 |
| :--- | :--- | :--- |
| **개념** | 메인 DW와 예비 DW 간에 주기적인 데이터 동기화 파이프라인을 구축하여 동일한 상태를 유지함. | 상태 및 마스터 데이터를 메인 DB로 완전히 이전하고, DW는 순수 로그/임시 적재용으로만 사용함. |
| **장점** | 기존 데이터베이스 스키마와 쿼리 로직을 거의 수정하지 않아도 됨. | 데이터 정합성이 100% 보장되며, 예비 DW로 우회할 때 동기화 상태를 신경 쓸 필요가 없음. DW 구조가 단순해짐. |
| **단점** | 동기화 지연(Lag) 발생 가능. 동기화를 위한 추가 네트워크 트래픽 발생으로 쿼터 소모 가속화. | 기존 소스 코드의 데이터베이스 조회 레이어 및 마이그레이션 스크립트를 대대적으로 수정해야 함. |
| **선택 여부** | 탈락 | **최종 선택** |

**대안 2를 선택한 이유:**
동기화 메커니즘을 추가하는 것은 시스템의 복잡도를 높이고, 결국 또 다른 네트워크 쿼터 소모를 부르는 악순환을 낳는다고 판단했습니다. 데이터의 원천(Single Source of Truth)을 명확히 하고, DW는 언제든 유실되거나 새로 구축해도 무방한 **"Stateless한 분석/로그 저장소"**로 격하시키는 것이 장기적인 유지보수와 아키텍처 안정성 측면에서 훨씬 견고한 선택이었습니다.

---

## 🏗️ 시스템 아키텍처 및 흐름

재설계한 PickSafe의 데이터 흐름 및 Failover 아키텍처는 다음과 같습니다. 메인 DB(DB A)는 상태와 마스터 데이터의 원천이 되고, DW DB(DB B)는 철저히 모니터링 및 임시 적재용으로 분리되었습니다.

```mermaid
graph TD
    subgraph Main_DB_Layer ["Main Database (DB A)"]
        A["ingredients_master (SSOT)"]
        B["seeding_schedule_settings"]
    end

    subgraph DW_Layer ["Data Warehouse Layer"]
        C["Primary DW (Neon DB 1)"]
        D["Secondary DW (Neon DB 2)"]
    end

    App["PickSafe Application Server"] -->|1. Reads Master/Config| Main_DB_Layer
    App -->|2. Writes/Reads Logs & Staging| C
    App -.->|3. Failover (On Connection Failure)| D

    subgraph Recovery_Thread ["Background Recovery Thread"]
        E["Check Primary DW Connection (Every 6h)"] -->|Success on 1st of Month| F["Restart Server to Restore Primary Connection"]
    end
```

---

## 💻 핵심 구현 및 트러블슈팅

### 1. 동적 DB 커넥션 팩토리 및 Failover 구현
기존 단일 DB 연결 구조에서 예외 발생 시 예비 DB로 커넥션을 전환하는 팩토리 클래스를 구현했습니다. 민감한 DB 크리덴셜 정보는 `SETTINGS` 환경변수로 마스킹하여 관리합니다.

```python
import logging
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import OperationalError

logger = logging.getLogger(__name__)

class DWDatabaseConnectionManager:
    def __init__(self):
        self.primary_url = SETTINGS.DATABASE_DW_URL
        self.secondary_url = SETTINGS.DATABASE_DW_URL_2
        self.current_url = self.primary_url
        self.engine = None
        self._init_engine()

    def _init_engine(self):
        try:
            self.engine = create_engine(self.current_url, pool_pre_ping=True, pool_recycle=3600)
            # 연결 테스트
            with self.engine.connect() as conn:
                pass
            logger.info("Successfully connected to Primary DW.")
        except OperationalError:
            logger.warning("Primary DW connection failed. Attempting failover to Secondary DW...")
            self._failover()

    def _failover(self):
        try:
            self.current_url = self.secondary_url
            self.engine = create_engine(self.current_url, pool_pre_ping=True, pool_recycle=3600)
            with self.engine.connect() as conn:
                pass
            logger.info("Successfully failed over to Secondary DW.")
        except OperationalError as e:
            logger.critical(f"Both DW databases are unavailable: {e}")
            raise e

    def get_session(self):
        if not self.engine:
            self._init_engine()
        return sessionmaker(bind=self.engine)()

dw_manager = DWDatabaseConnectionManager()
```

### 2. 주기적 메인 DB 복구 모니터링 스레드
Neon DB의 사용량 제한은 매월 1일에 초기화됩니다. 따라서 예비 DW로 전환된 상태에서 매월 1일이 지나 메인 DW의 쿼터가 복구되면, 이를 감지하여 자동으로 메인 DB 커넥션을 복원하는 백그라운드 데몬 스레드를 구축했습니다.

```python
import time
import threading
from datetime import datetime

def check_primary_db_recovery():
    """
    6시간 주기로 메인 DW의 상태를 체크하고, 
    매월 초 쿼터가 초기화되어 복구되었음이 감지되면 안전한 전환을 위해 서버를 재시작합니다.
    """
    while True:
        time.sleep(21600)  # 6시간 주기
        
        # 현재 예비 DW를 사용 중인 상태인지 확인
        if dw_manager.current_url == SETTINGS.DATABASE_DW_URL_2:
            try:
                temp_engine = create_engine(SETTINGS.DATABASE_DW_URL, connect_timeout=10)
                with temp_engine.connect() as conn:
                    logger.info("Primary DW availability detected.")
                    
                # 안전한 커넥션 풀 초기화를 위해 프로세스 우아한 재시작(Graceful Restart) 신호 송신
                # 여기서는 간소화하여 로그 후 재시작 트리거만 묘사합니다.
                if datetime.now().day == 1:
                    logger.info("First day of the month detected. Triggering graceful restart to restore Primary DW.")
                    trigger_graceful_restart()
            except OperationalError:
                logger.info("Primary DW is still unreachable. Keeping Secondary DW connection.")
```

### 3. 트러블슈팅: Failover 시 커넥션 풀의 고사(Stale Connection) 문제
초기 테스트 시, 메인 DW가 죽었을 때 기존 커넥션 풀에 담겨 있던 커넥션들이 에러를 뿜으며 즉시 예비 DW로 전환되지 않는 문제가 있었습니다. 

이를 해결하기 위해 SQLAlchemy의 `pool_pre_ping=True` 옵션을 활성화했습니다. 이 옵션은 커넥션 풀에서 커넥션을 꺼낼 때마다 가벼운 `SELECT 1` 쿼리를 던져 연결 생존 여부를 검증합니다. 연결이 끊어졌다면 즉시 폐기하고 새로 연결을 맺어주기 때문에, 인프라 장애 발생 시 애플리케이션 레이어에서 에러를 최소화하며 부드럽게 예비 DW로 전환할 수 있었습니다.

---

## 💡 돌아보며 배운 점 (회고)

이번 작업을 통해 엔지니어로서 몇 가지 중요한 교훈을 얻었습니다.

1. **데이터의 성격에 따른 엄격한 저장소 분리:** 
   분석용 마스터 데이터와 스케줄러 상태 데이터가 DW에 섞여 들어갔던 것 자체가 초기 설계의 안일함이었습니다. "어차피 같은 데이터베이스인데 어때"라는 생각이 인프라 장애 상황에서 얼마나 큰 재앙(데이터 정합성 훼손)으로 다가올 수 있는지 뼈저리게 배웠습니다. 상태 데이터는 철저히 영속성이 보장되는 메인 OLTP DB로 가야 합니다.

2. **단순한 복구 메커니즘이 복잡한 동기화보다 낫다:** 
   두 DW DB 간의 양방향 동기화를 고민하느라 이틀을 보냈지만, 결국 아키텍처를 단순화하고 Stateless하게 만드는 것이 정답이었습니다. 복잡한 기술적 장치를 더하기 전에, 설계 자체를 단순화할 방법이 없는지 먼저 자문해야 함을 다시금 깨달았습니다.

3. **모니터링의 중요성:** 
   현재 어드민 화면의 인프라 대시보드에 예비 DB 접속 여부를 **"개발 DW2 (DEV)"**, **"운영 DW2 (PROD)"**와 같이 명시적으로 노출하도록 개선했습니다. 시스템이 스스로 복구되더라도, 운영자가 현재 인프라의 비정상 상태를 인지할 수 있는 가시성을 확보하는 것이 실무에서 얼마나 중요한지 체감했습니다.

인프라의 한계는 예기치 못한 순간에 찾아옵니다. 하지만 그 한계를 극복하는 과정에서 시스템은 한 단계 더 단단해진다는 것을 이번 회고를 작성하며 다시 한번 마음에 새깁니다.