---
title: "[Lookalike] 데이터 엔지니어 최종프로젝트 1주차 수행일지"
date: "2026-01-30 09:00:00"
category: "Lookalike"
tags: ["Architecture", "Backend", "Optimization"]
---

# (2026.01.26 ~ 2026.01.30)
---
## 🎯 이번 주 팀 목표
- workflow 재정의
- 모델 학습
- 크롤링 샘플 만들기

---
## 👥 팀원별 TIL

### 🔹 [한대성] - [팀장/Data Engineer]

#### 💡 Keep (유지할 것)
- FrontEnd UI Prototype
- Git hub merge로 인한 자동배포 시스템
- workflow 설계

#### 🔍 Problem (문제점)
- Airflow 버전에 따른 다른 지원 및 설정
- Hadoop 설치에 대한 에러 발생
- Docker 묶음의 기준

#### ✨ Try (시도할 것)
- 환경 설정에 대한 가이드 수정
- 최초 환경 구성 Docker 구성화
- AWS 안전 종료 shell 스크립트 구현
- 각 팀원 Git hub 사용 교육


### 🔹 [박주언] - [팀원/Data Engineer]

#### 💡 Keep (유지할 것)
- 데이타 파이프라인 설치 가이드 작성중
- Crawling -> 전처리(Spark) -> Airflow

#### 🔍 Problem (문제점)
- 각 S/W에 대한 기술적인 이해 부족
- 각 단계시 시행시 마다 Error 발생하여 시간이 많이 걸림

#### ✨ Try (시도할 것) 
- Crawling -> 전처리(Spark) -> Airflow
- 각 단계시 시행시 마다 Error 발생하여 시간이 많이 걸림
- 데이타 파이프라인 설치 가이드 완성

### 🔹 [이주형] - [팀원/Data Science]

#### 💡 Keep (유지할 것)
- 브랜드 수집기 및 HDFS 적재 파이프라인 구축
- 비정형 HTML 구조(가격/단위 분리)에 대응하는 상대 위치 기반 파싱 알고리즘 적용

#### 🔍 Problem (문제점)
- VLM을 사용한 키워드 생성을 위한 적절한 프롬프트 생성
- 단순 URL 조립 시 보안 토큰 부재 및 브랜드 슬러그 불일치(대소문자/하이픈)로 인한 수집 실패
- 대량의 HTML 파일 적재 시 datanode 손상 및 타임아웃 발생
- Headless 브라우저를 CLI 환경에서 실행이 안되는 문제 발생

#### ✨ Try (시도할 것)
- 개별 테스트 완료된 브랜드별 파싱 로직을 Spark Job으로 병합하여 PostgreSQL 적재 자동화.
- 적재된 상품 데이터를 기반으로 FashionCLIP 임베딩 생성 및 Vector DB(pgvector/Elasticsearch) 인덱싱 파이프라인 연결


### 🔹 [정수아] - [팀원/Data Science]

#### 💡 Keep (유지할 것)
- 객체 탐지 모델 학습을 위한 데이터 전처리 프로세스
- 객체 탐지 모델 파인튜닝을 통한 성능 개선 프로세스

#### 🔍 Problem (문제점)
- 모델 성능이 기대 수준에 미치지 못함
- 모델 성능 개선 결과가 사전 가설과 일부 불일치함
- VMware Fusion 사용 중 환경 관련 오류 발생

#### ✨ Try (시도할 것)
- 평가 지표에 대한 목표 수치 정의
- 모델 아키텍처 및 학습 프로세스 확정

---
## 📝 이번 주 팀 회고
### ✅ 성과 (이번 주에 팀이 달성한 주요 성과나 진척사항)
- FrontEnd UI Prototype

![이미지](/blog_images/img_2eff4711.png)


- workflow 개념 정리

![이미지](/blog_images/img_63224121.png)


- Yolo 파인튜닝

![이미지](/blog_images/img_39bc0b47.png)



### ⚠️ 개선 필요 사항 (팀 차원에서 개선이 필요한 부분)
- 크롤링에 관련된 룰과 방법론에 대해 기준 개선
### 🎯 다음 주 목표 (다음 주에 집중할 팀 목표)
- AWS 환경 구성
- 모델 학습
---
### 🔗 참고 자료
*   [데이터 파이프라인 구축 - 이론](https://www.blogger.com/blog/post/edit/7999225441070233298/7977143675835513175?hl=ko#)
*   [YOLO V11 리뷰 1.사용법](https://www.blogger.com/blog/post/edit/7999225441070233298/7977143675835513175?hl=ko#)
---
### 💬 한줄 소감
- [한대성]: workflow 설계와 환경 설치의 어려움의 과정
- [박주언]: 사용 기술에 대한 이해 부족에 대한 어려움
- [이주형]: 브라우저 동작 원리와 웹 보안 프로토콜에 대해 알게 되었습니다.
- [정수아]: YOLO를 통해 객체 탐지 모델의 흐름을 이해할 수 있었습니다.
---
첨부파일 :

[📋1주차 수행일지](https://www.blogger.com/blog/post/edit/7999225441070233298/7977143675835513175?hl=ko#)

[📋최종 기획안](https://www.blogger.com/blog/post/edit/7999225441070233298/7977143675835513175?hl=ko#)

_다음 주에도 화이팅! 🚀_