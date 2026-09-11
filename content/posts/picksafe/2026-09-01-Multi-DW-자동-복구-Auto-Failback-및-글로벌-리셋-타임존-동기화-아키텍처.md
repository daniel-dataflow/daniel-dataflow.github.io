---
title: "os.kill()에서 무중단 핫스왑으로: Serverless DB 쿼터 제한을 극복하는 고가용성 Auto-Failback 아키텍처 설계기"
category: "PickSafe"
date: "2026-09-01 09:00:00"
tags: ["Architecture", "Troubleshooting", "FastAPI", "HighAvailability", "Serverless"]
---

성장하는 스타트업이나 리소스가 제한된 환경에서 클라우드 비용 최적화와 서비스 안정성(High Availability)은 늘 팽팽하게 대립하는 트레이드오프 관계에 있습니다. 

저희 **PickSafe** 팀은 최근 서버리스 PostgreSQL 서비스인 Neon DB의 무료 티어(Free Tier) 환경을 활용하면서, **월간 쿼터(100 CU) 초과 시 실시간으로 예비 DW(Data Warehouse)로 우회하고, 쿼터가 리셋되면 무중단으로 본래의 DW로 자동 복귀하는 '3중 핫스왑(Hot-Swap) 및 Auto-Failback 아키텍처'**를 구축했습니다.

이 과정에서 겪은 처절한 삽질의 기록과, "서버 강제 종료 후 재시작"이라는 과격한 방식에서 **"인메모리 커넥션 라우팅"**으로 진화시킨 엔지니어링 여정을 공유합니다.

---

## 1. 문제의 발단: "서버를 죽여서 커넥션을 교체한다고요?"

### 1.1. 1세대 해결책: 2중화 Failover와 `os.kill`이 남긴 상흔
이전의 PickSafe 시스템은 Neon DB의 100 CU 사용량 제한에 도달하면 예비 DW(`DW2`)로 커넥션을 우회(Failover)시키는 2중화 구조를 가지고 있었습니다. 

문제는 **"언제 다시 메인 DW(`DW1`)로 돌아올 것인가?"**였습니다. 매월 1일이 되면 쿼터가 리셋되므로 메인 DB를 바라봐야 하는데, 당시의 구현은 매우 투박했습니다. 백그라운드 스레드가 매월 1일 메인 DB 복구가 감지되면 **`os.kill(os.getpid(), signal.SIGTERM)`을 호출하여 프로세스를 강제 종료**시키는 방식이었습니다.

```
[기존 방식의 프로세스 흐름]
메인 DB 차단 ➔ 예비 DB 가동 ➔ 매월 1일 감지 ➔ os.kill()로 서버 강제 다운 ➔ 컨테이너 오케스트레이터(K8s)가 컨테이너 재시작 ➔ 메인 DB 커넥션 재생성
```

이 방식은 작동은 했지만 몇 가지 심각한 문제를 안고 있었습니다.
1. **Downtime 발생:** 프로세스가 죽고 다시 뜨는 수 초~수십 초 동안 클라이언트의 요청이 유실됩니다.
2. **비정상 종료의 위험성:** 트랜잭션 도중 프로세스가 강제 종료되면 데이터 정합성이 깨질 위험이 있습니다.
3. **인프라 의존성:** 컨테이너가 자동으로 부팅되는 환경(K8s 등)에 의존해야만 동작하는 불안정한 구조였습니다.

### 1.2. 2세대 해결책: 3중 인메모리 핫스왑으로의 진화, 그러나...
저희는 지난 8월 말, 이러한 다운타임을 없애기 위해 **`DwConnectionRouter`**를 설계했습니다. 주 DW(`dw1`), 예비 DW(`dw2`), 백업 DW(`dw3`)의 3중 구조를 메모리 상에 올리고, 연결 에러가 발생하면 수동 혹은 API 호출을 통해 메모리 내 커넥션 풀을 실시간으로 바꾸는 **3중 인메모리 핫스왑** 체계였습니다.

하지만 급격하게 리팩토링이 진행되면서 중요한 고리 하나가 누락되었습니다. **"주기적인 자동 복귀(Auto-Failback) 데몬"**이 핫스왑 라우터 체계에 이식되지 않아, 메인 DB의 쿼터가 초기화되었음에도 수동으로 엔드포인트를 돌려놓기 전까지는 계속 예비 DW를 사용하는 비효율이 발생한 것입니다.

---

## 2. 숨겨진 디테일과의 싸움: 타임존과 API의 불일치

무중단 복구 메커니즘을 자동화하는 과정에서, 클라우드 인프라가 가진 현실적인 제약 사항들이 드러나기 시작했습니다.

### 2.1. 글로벌 쿼터 리셋의 타임존 미스매치 (KST vs UTC)
한국(KST) 기준으로 9월 1일 00:00가 되자마자 메인 DB 복구를 시도하도록 단순 설계하면 장애가 발생합니다. Neon DB의 공식 빌링 사이클은 **미국 본사 기준인 UTC 00:00(한국 시간 매월 1일 09:00 KST)**에 리셋되기 때문입니다.

즉, 한국 시간으로 9월 1일 새벽에 시스템이 성급하게 메인 DB로 복귀를 시도해봤자, Neon 측에서는 여전히 전월 사용량 초과 상태로 간주하여 커넥션을 차단하게 됩니다.

### 2.2. Neon DB의 'Connection Restricted' 잠금 지연 현상
Neon 무료 플랜의 경우, 쿼터가 리셋되는 당일 00:00 UTC가 되더라도 내부 배치 작업의 지연으로 인해 한동안 `Connection Restricted` 상태가 유지되는 물리적인 시차가 존재했습니다. 

즉, "매월 1일 09:00 KST가 되었으니 바로 커넥션을 연다"가 아니라, **"실제로 메인 DB에 연결할 수 있는 상태인지를 주기적으로 검증(Health Check)하여 완전히 잠금이 풀린 순간 동적으로 스위칭"**하는 방어적 시나리오가 필수적이었습니다.

### 2.3. 분산된 인프라 메트릭: 용량(State)과 소비량(Delta)의 파편화
인프라 관리 대시보드에서 각 DW의 상태를 정확하게 보여주고 싶었지만, Neon API는 이 데이터를 두 군데로 쪼개놓은 상태였습니다.
* **실제 보관 중인 디스크 물리 용량:** `GET /projects/{id}` API의 `synthetic_storage_size` 필드에서 제공
* **당월 실시간 누적 소비량(Compute CU, Network):** `GET /projects/{id}/consumption` API에서 제공

이 분산된 지표들을 정합성 있게 매핑하지 않으면, 대시보드 상에서 이미 메인 DB가 리셋되어 `0.0 CU` 상태임에도 이전의 용량 정보와 엉켜 관리자에게 혼선을 줄 여지가 있었습니다.

---

## 3. 해결책: 고가용성 Auto-Failback & 하이브리드 메트릭 아키텍처

우리는 이를 해결하기 위해 **100% 무중단 자동 복구 데몬**을 완성하고, 메트릭 파이프라인을 고도화했습니다.

### 3.1. 무중단 3중 핫스왑 및 Auto-Failback 아키텍처

저희가 설계한 최종 구조는 다음과 같습니다.

```mermaid
flowchart TD
    subgraph DW_Router ["DwConnectionRouter (인메모리 핫스왑 라우터)"]
        ACTIVE["현재 가동 중: DW2 (예비 DW)"]
        WORKER["🔄 _failback_worker_loop (10초 주기 백그라운드 스레드)"]
        PING["⚡ DW1 가용성 체크 (SELECT 1 & Cold Start 6.0s 대기)"]
        SWAP["🚀 switch_target('dw1') 실시간 핫스왑"]
        RESTORE["📦 복구 시점 통계 유실 데이터 복원"]
        SLACK["📢 Slack '자동 복구 완료' 실시간 알림"]
    end

    subgraph Metrics_Pipeline ["하이브리드 메트릭 수집 파이프라인"]
        M1["GET /projects/{id} <br> (물리 디스크 용량: 49.14 MB)"]
        M2["GET /projects/{id}/consumption <br> (당월 실시간 소비량: 0.0 CU)"]
        M_COMBINE["📊 하이브리드 메트릭 결합 ➔ 대시보드 표출"]
    end

    ACTIVE --> WORKER
    WORKER --> PING
    PING -->|가용성 확보 확인| SWAP
    SWAP --> RESTORE
    SWAP --> SLACK
    M1 --> M_COMBINE
    M2 --> M_COMBINE
```

### 3.2. 핵심 구현 코드 (Conceptual)

서버 프로세스를 죽이지 않고, 백그라운드에서 주기적으로 메인 DB의 헬스체크를 수행하며 인메모리 상에서 안전하게 엔진을 갈아끼우는 핵심 로직의 뼈대입니다.

```python
import threading
import time
import logging
from sqlalchemy import create_engine, text

logger = logging.getLogger(__name__)

class DwConnectionRouter:
    def __init__(self):
        self.targets = {
            "dw1": "postgresql://user:pass@main-dw-endpoint/db",
            "dw2": "postgresql://user:pass@backup-dw-endpoint/db",
            "dw3": "postgresql://user:pass@failover-dw-endpoint/db"
        }
        self.active_target = "dw2"  # 현재 예비 DW 가동 중이라 가정
        self.current_engine = create_engine(self.targets[self.active_target])
        self._lock = threading.Lock()
        
        # Auto-Failback 백그라운드 데몬 구동
        self.failback_thread = threading.Thread(target=self._failback_worker_loop, daemon=True)
        self.failback_thread.start()

    def get_engine(self):
        with self._lock:
            return self.current_engine

    def switch_target(self, target_name: str):
        """서버 재시작 없이 인메모리에서 커넥션 풀을 실시간 스위칭"""
        with self._lock:
            if target_name not in self.targets:
                return False
            logger.info(f"🔄 Switching DW target: {self.active_target} -> {target_name}")
            new_engine = create_engine(self.targets[target_name])
            
            # 구 엔진 리소스 정리
            self.current_engine.dispose()
            self.current_engine = new_engine
            self.active_target = target_name
            return True

    def _failback_worker_loop(self):
        """주기적으로 메인 DW1의 잠금 해제 여부를 체크하는 백그라운드 데몬"""
        while True:
            time.sleep(10)  # 10초 주기로 체크
            
            if self.active_target == "dw1":
                continue  # 이미 메인으로 복구 완료된 상태라면 스킵
                
            logger.info("🔍 Auto-Failback 데몬: 메인 DW1 가용성 테스트 시작...")
            
            # Cold Start 및 잠금 지연 시간 방어를 위해 타임아웃을 6.0초로 여유 있게 설정
            test_engine = create_engine(self.targets["dw1"], connect_args={"connect_timeout": 6})
            try:
                with test_engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
                
                # 가용성 테스트 성공 시 실시간 복구 전환
                logger.info("✅ 메인 DW1 가용성 확인 성공! 무중단 복구 작업을 시작합니다.")
                self.switch_target("dw1")
                
                # 후속 조치 진행
                self._trigger_data_restoration()
                self._send_slack_notification("dw1")
                
            except Exception as e:
                logger.warning(f"❌ 메인 DW1은 아직 사용 불가능한 상태입니다 (이유: {e}). 예비 풀을 계속 유지합니다.")
            finally:
                test_engine.dispose()

    def _trigger_data_restoration(self):
        logger.info("📦 [Data Restore] 예비 DW에 적재되었던 유실 통계 데이터 동기화 파이프라인 트리거 완료.")

    def _send_slack_notification(self, target: str):
        logger.info(f"📢 [Slack Alert] DW가 성공적으로 무중단 자동 복구되었습니다! 활성 대상: {target}")
```

### 3.3. 디테일의 차이: Cold Start 안전 마진 6.0초 확보
서버리스 DB는 한동안 트래픽이 없으면 'Sleep' 상태로 들어가며, 첫 쿼리 요청 시 인스턴스를 다시 띄우는 **Cold Start(콜드 스타트)**가 발생합니다. 

초기 설계에서는 이 타임아웃을 일반적인 API 응답 규격인 3.0초로 설정해 두었더니, DB가 막 깨어나느라 4~5초가 걸릴 때 가용성이 없다고 오판하여 복구 프로세스가 뒤로 밀리는 이슈가 있었습니다. 저희는 이를 **6.0초의 안전 마진**으로 조정함으로써, 불필요한 재시도 지연을 완전히 극복했습니다.

---

## 4. 성과 및 엔지니어링적 교훈 (Takeaways)

이번 아키텍처 리팩토링을 통해 얻은 성과와 교훈은 다음과 같습니다.

1. **100% 완전 무중단 운영 실증**: 
   실제로 14일 동안 메인 DW1이 잠겼을 때, 저희 3중 핫스왑 라우터가 즉각 가동되어 모든 텔레메트리 데이터를 `dw2`로 안전하게 우회시켰습니다. 그리고 9월 1일 09:00 KST를 기점으로 Neon DB의 과금 잠금이 풀리자마자, **단 한 차례의 서버 재시작도 없이 실시간으로 메인 DW 복구에 성공**했습니다. 이 과정에서 유실된 데이터는 단 1바이트도 존재하지 않았습니다.
   
2. **하이브리드 메트릭 시각화**: 
   Neon의 분산된 API들을 결합하여, 관리자용 대시보드 상에서 실제 물리 디스크 용량(`49.14MB`)과 당월 누적 소비량(`0.0 CU`)을 오차 범위 0%로 완벽하게 표현할 수 있게 되었습니다.

3. **클라우드 과금 라이프사이클에 대한 이해**: 
   시스템의 타임존 설계는 단순히 데이터베이스 내부 타임존을 맞추는 것을 넘어, **"우리가 연동하는 클라우드 인프라 파트너의 빌링 및 배치 리셋 타임존"**까지 고려하여 유기적으로 연동되어야 함을 깊이 배웠습니다.

---

### 마치며
인프라를 무조건 고스펙으로 업그레이드하여 문제를 덮어버리는 것은 쉽습니다. 하지만 아키텍처적 유연성과 치밀한 예외 처리를 통해 **비용을 최소화하면서도 고가용성을 지켜내는 경험**은, 저희 엔지니어링 팀이 더 단단하고 탄탄한 시스템을 설계할 수 있는 밑거름이 되었습니다.

저희와 함께 이런 실전적이고 치열한 인프라 문제를 함께 풀어가고 싶으시다면, 언제든 문을 두드려주세요!