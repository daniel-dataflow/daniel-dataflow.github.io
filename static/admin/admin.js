/**
 * Daniel Tech Blog - Standalone In-Repo Web Admin Studio & CMS
 * Fully self-contained inside daniel-dataflow.github.io-main
 * Connects directly to GitHub REST API (No external server required)
 */

const GITHUB_OWNER = 'daniel-dataflow';
const GITHUB_REPO = 'daniel-dataflow.github.io';
const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

let githubPat = localStorage.getItem('gh_admin_pat') || '';
let currentEditingPost = null; // { path, sha, category, filename, title }
let allPublishedPosts = [];
let allCategories = [];
let isEditorDirty = false;

// ─── 1. Initialization ───
document.addEventListener('DOMContentLoaded', () => {
  initMermaid();
  checkAuthentication();
  initDragAndDrop();
  initPasteImage();
});

function initMermaid() {
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      fontFamily: 'Pretendard, Inter, sans-serif'
    });
  }
}

function checkAuthentication() {
  if (!githubPat) {
    document.getElementById('loginOverlay').style.display = 'flex';
  } else {
    document.getElementById('loginOverlay').style.display = 'none';
    loadAllBlogData();
  }
}

async function authenticateAdmin() {
  const input = document.getElementById('adminPatInput').value.trim();
  if (!input) {
    alert('GitHub Personal Access Token을 입력해 주세요.');
    return;
  }

  // Verify token by making a lightweight request
  try {
    const res = await fetch(`https://api.github.com/user`, {
      headers: {
        'Authorization': `token ${input}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (res.status === 200) {
      githubPat = input;
      localStorage.setItem('gh_admin_pat', githubPat);
      document.getElementById('loginOverlay').style.display = 'none';
      alert('✨ 관리자 인증 성공! 환영합니다.');
      loadAllBlogData();
    } else {
      alert('유효하지 않은 GitHub 토큰입니다. 권한(repo)을 확인해 주세요.');
    }
  } catch (e) {
    alert('인증 중 오류가 발생했습니다: ' + e.message);
  }
}

function logoutAdmin() {
  if (confirm('정말로 관리자 세션에서 로그아웃하시겠습니까?')) {
    localStorage.removeItem('gh_admin_pat');
    githubPat = '';
    location.reload();
  }
}

// ─── 2. GitHub REST API Helpers ───
async function ghRequest(endpoint, options = {}) {
  const headers = {
    'Authorization': `token ${githubPat}`,
    'Accept': 'application/vnd.github.v3+json',
    ...(options.headers || {})
  };

  const res = await fetch(`${API_BASE}/${endpoint.replace(/^\//, '')}`, {
    ...options,
    headers
  });

  return res;
}

// Helper to decode Base64 UTF-8 string
function decodeBase64Utf8(base64Str) {
  try {
    const binString = atob(base64Str.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return atob(base64Str);
  }
}

// Helper to encode UTF-8 to Base64
function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
  return btoa(binString);
}

// ─── 3. Load Blog Data (Categories & Posts) ───
async function loadAllBlogData() {
  await loadCategories();
  await loadPublishedPosts();
}

async function loadCategories() {
  try {
    const res = await ghRequest('contents/content/posts');
    if (res.status === 200) {
      const items = await res.json();
      allCategories = items
        .filter(item => item.type === 'dir' && !item.name.startsWith('.'))
        .map(item => ({
          slug: item.name,
          name: item.name.replace(/-/g, ' ').toUpperCase(),
          path: item.path
        }));

      updateCategoryDropdown();
      const countEl = document.getElementById('catCountNum');
      if (countEl) countEl.textContent = allCategories.length;
    }
  } catch (e) {
    console.error('카테고리 로드 실패:', e);
  }
}

function updateCategoryDropdown() {
  const select = document.getElementById('postCategorySelect');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '';

  allCategories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.slug;
    opt.textContent = `📁 ${cat.slug}`;
    select.appendChild(opt);
  });

  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '➕ 새 카테고리 추가...';
  select.appendChild(newOpt);

  if (currentVal && currentVal !== '__new__') {
    select.value = currentVal;
  } else if (allCategories.length > 0) {
    select.value = allCategories[0].slug;
  }
}

function handleCategoryChange(val) {
  if (val === '__new__') {
    openCategoryModal();
    if (allCategories.length > 0) {
      document.getElementById('postCategorySelect').value = allCategories[0].slug;
    }
  }
}

async function loadPublishedPosts() {
  const listContainer = document.getElementById('sidebarItemsList');
  if (listContainer) listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">포스트 목록 로딩 중...</div>';

  allPublishedPosts = [];

  try {
    // Traverse each category directory
    for (const cat of allCategories) {
      const res = await ghRequest(`contents/content/posts/${cat.slug}`);
      if (res.status === 200) {
        const files = await res.json();
        for (const file of files) {
          if (file.type === 'file' && file.name.endsWith('.md') && file.name !== '_index.md') {
            allPublishedPosts.push({
              name: file.name,
              path: file.path,
              sha: file.sha,
              category: cat.slug,
              download_url: file.download_url
            });
          }
        }
      }
    }

    const countEl = document.getElementById('postCountNum');
    if (countEl) countEl.textContent = allPublishedPosts.length;

    renderPostsList();
  } catch (e) {
    console.error('포스트 목록 로드 실패:', e);
    if (listContainer) listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #f43f5e;">목록 로드 실패</div>';
  }
}

function renderPostsList() {
  const listContainer = document.getElementById('sidebarItemsList');
  if (!listContainer) return;

  if (allPublishedPosts.length === 0) {
    listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">발행된 글이 없습니다.</div>';
    return;
  }

  listContainer.innerHTML = allPublishedPosts.map((post, idx) => `
    <div class="post-item-card ${currentEditingPost && currentEditingPost.path === post.path ? 'active' : ''}">
      <div class="post-item-info" onclick="loadPostContent('${post.path}', '${post.sha}', '${post.category}', '${post.name}')">
        <div class="post-item-title">${escapeHtml(post.name.replace('.md', ''))}</div>
        <div class="post-item-meta">
          <span class="post-cat-pill">${escapeHtml(post.category)}</span>
        </div>
      </div>
      <button type="button" class="post-del-btn" title="포스트 삭제" onclick="deletePostFromGitHub('${post.path}', '${post.sha}', '${post.name}', event)">
        <i class="fa-regular fa-trash-can"></i>
      </button>
    </div>
  `).join('');
}

function filterPostsList() {
  const q = document.getElementById('postSearchInput').value.toLowerCase().trim();
  const cards = document.querySelectorAll('.post-item-card');
  cards.forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(q) ? 'flex' : 'none';
  });
}

function switchSidebarTab(tab) {
  const tabPosts = document.getElementById('tabPosts');
  const tabCats = document.getElementById('tabCategories');
  const listContainer = document.getElementById('sidebarItemsList');

  if (tab === 'posts') {
    tabPosts.classList.add('active');
    tabCats.classList.remove('active');
    renderPostsList();
  } else {
    tabPosts.classList.remove('active');
    tabCats.classList.add('active');
    renderCategoriesList();
  }
}

function renderCategoriesList() {
  const listContainer = document.getElementById('sidebarItemsList');
  if (!listContainer) return;

  listContainer.innerHTML = allCategories.map(cat => `
    <div class="post-item-card" onclick="openCategoryModal()">
      <div class="post-item-info">
        <div class="post-item-title">📁 ${escapeHtml(cat.slug)}</div>
        <div class="post-item-meta">
          <span>content/posts/${escapeHtml(cat.slug)}</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ─── 4. Post Selection & Editor Logic ───
async function loadPostContent(path, sha, category, filename) {
  try {
    const res = await ghRequest(`contents/${path}`);
    if (res.status === 200) {
      const data = await res.json();
      const content = decodeBase64Utf8(data.content);

      currentEditingPost = { path, sha: data.sha, category, filename };
      document.getElementById('markdownEditor').value = content;
      document.getElementById('currentDocStatusBadge').textContent = `[${category}] ${filename}`;
      document.getElementById('postCategorySelect').value = category;

      handleEditorChange();
      renderPostsList();
    }
  } catch (e) {
    alert('포스트 내용을 불러오는 중 오류가 발생했습니다: ' + e.message);
  }
}

function startNewPost() {
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const currentCat = document.getElementById('postCategorySelect').value || 'picksafe';

  currentEditingPost = null;
  document.getElementById('currentDocStatusBadge').textContent = '✨ 새 글 작성 모드';

  const defaultTemplate = `---
title: "새 글 제목을 입력하세요"
date: "${dateStr}"
categories: ["${currentCat}"]
category: "${currentCat}"
tags: ["Architecture", "Backend", "Tech"]
---

여기에 마크다운 본문을 작성하세요.

## 🎯 문제 정의
- 핵심 문제 및 배경 설명

## 🏗️ 아키텍처 및 구현
\`\`\`python
# 핵심 코드 작성
def example():
    return "Hello Daniel Tech Blog!"
\`\`\`

## 💡 결론 및 배운 점
- 성과 및 교훈 정리
`;

  document.getElementById('markdownEditor').value = defaultTemplate;
  handleEditorChange();
}

async function publishPostToGitHub() {
  const content = document.getElementById('markdownEditor').value.trim();
  const category = document.getElementById('postCategorySelect').value || 'picksafe';

  if (!content) {
    alert('에디터에 발행할 마크다운 내용이 없습니다.');
    return;
  }

  // Extract or generate filename
  let filename = currentEditingPost ? currentEditingPost.filename : '';
  if (!filename) {
    const titleMatch = content.match(/title:\s*["']?(.*?)["']?\s*$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'new-post';
    const dateStr = new Date().toISOString().substring(0, 10);
    const safeTitle = title.replace(/[^a-zA-Z0-9가-힣_-]/g, '-').replace(/-+/g, '-').substring(0, 35);
    filename = `${dateStr}-${safeTitle}.md`;
  }

  const targetPath = `content/posts/${category}/${filename}`;

  if (!confirm(`다음 포스트를 GitHub [${category}] 카테고리에 배포하시겠습니까?\n\n경로: ${targetPath}`)) {
    return;
  }

  const btn = document.getElementById('btnPublish');
  const origText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 배포 중...';
  btn.disabled = true;

  try {
    // Get existing SHA if file exists
    let sha = currentEditingPost ? currentEditingPost.sha : null;
    if (!sha) {
      const checkRes = await ghRequest(`contents/${targetPath}`);
      if (checkRes.status === 200) {
        const checkData = await checkRes.json();
        sha = checkData.sha;
      }
    }

    const payload = {
      message: `Publish Post: ${filename} (via In-Repo Web Admin Studio)`,
      content: encodeBase64Utf8(content),
      branch: 'main'
    };
    if (sha) payload.sha = sha;

    const putRes = await ghRequest(`contents/${targetPath}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    if (putRes.status === 200 || putRes.status === 201) {
      alert(`🎉 포스트가 GitHub [${category}] 카테고리에 성공적으로 배포되었습니다!\n\n잠시 후 https://daniel-dataflow.github.io 에 자동 반영됩니다.`);
      await loadPublishedPosts();
      isEditorDirty = false;
    } else {
      const err = await putRes.json();
      alert('배포 실패: ' + (err.message || putRes.statusText));
    }
  } catch (e) {
    alert('배포 중 오류가 발생했습니다: ' + e.message);
  } finally {
    btn.innerHTML = origText;
    btn.disabled = false;
  }
}

async function deletePostFromGitHub(path, sha, filename, event) {
  if (event) event.stopPropagation();

  if (!confirm(`정말로 이 포스트를 영구 삭제하시겠습니까?\n\n파일명: ${filename}\n경로: ${path}\n\n⚠️ 삭제 시 GitHub 저장소에서 완전히 제거됩니다.`)) {
    return;
  }

  try {
    const payload = {
      message: `Delete post: ${filename} (via In-Repo Web Admin Studio)`,
      sha: sha,
      branch: 'main'
    };

    const res = await ghRequest(`contents/${path}`, {
      method: 'DELETE',
      body: JSON.stringify(payload)
    });

    if (res.status === 200 || res.status === 204) {
      alert(`🗑️ "${filename}" 포스트가 성공적으로 삭제되었습니다.`);
      if (currentEditingPost && currentEditingPost.path === path) {
        document.getElementById('markdownEditor').value = '';
        currentEditingPost = null;
        document.getElementById('currentDocStatusBadge').textContent = '삭제됨';
      }
      await loadPublishedPosts();
    } else {
      const err = await res.json();
      alert('삭제 실패: ' + (err.message || res.statusText));
    }
  } catch (e) {
    alert('삭제 중 오류가 발생했습니다: ' + e.message);
  }
}

// ─── 5. Global Blog Settings (hugo.yaml) Modal ───
async function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const statusEl = document.getElementById('settingsSaveStatus');
  modal.style.display = 'flex';
  statusEl.textContent = 'hugo.yaml 로드 중...';

  try {
    const res = await ghRequest('contents/hugo.yaml');
    if (res.status === 200) {
      const data = await res.json();
      const yamlText = decodeBase64Utf8(data.content);

      modal.dataset.yamlSha = data.sha;

      function getField(regex, defaultVal = '') {
        const m = yamlText.match(regex);
        return m ? m[1].replace(/["']/g, '').trim() : defaultVal;
      }

      document.getElementById('cfgSiteTitle').value = getField(/title:\s*["']?(.*?)["']?\s*$/m, 'Daniel Tech Blog');
      document.getElementById('cfgBannerBadge').value = getField(/banner_badge:\s*["']?(.*?)["']?\s*$/m, 'Engineering & Architecture Archive');
      document.getElementById('cfgSubtitle').value = getField(/subtitle:\s*["']?(.*?)["']?\s*$/m, '아키텍처 및 백엔드 엔지니어링 아카이브');
      document.getElementById('cfgDescription').value = getField(/description:\s*["']?(.*?)["']?\s*$/m, '');
      document.getElementById('cfgAuthor').value = getField(/author:\s*["']?(.*?)["']?\s*$/m, 'Daniel');
      document.getElementById('cfgAuthorRole').value = getField(/author_role:\s*["']?(.*?)["']?\s*$/m, 'Backend & Systems Architect');
      document.getElementById('cfgAuthorBio').value = getField(/author_bio:\s*["']?(.*?)["']?\s*$/m, '');
      document.getElementById('cfgEmail').value = getField(/email:\s*["']?(.*?)["']?\s*$/m, '');
      document.getElementById('cfgGithubUrl').value = getField(/github_url:\s*["']?(.*?)["']?\s*$/m, '');

      statusEl.textContent = '설정 불러오기 완료';
    }
  } catch (e) {
    statusEl.textContent = '로드 실패: ' + e.message;
  }
}

function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
}

async function saveSiteSettingsToGitHub() {
  const statusEl = document.getElementById('settingsSaveStatus');
  statusEl.textContent = '💾 GitHub 배포 중...';

  const modal = document.getElementById('settingsModal');
  const sha = modal.dataset.yamlSha;

  const title = document.getElementById('cfgSiteTitle').value.trim();
  const bannerBadge = document.getElementById('cfgBannerBadge').value.trim();
  const subtitle = document.getElementById('cfgSubtitle').value.trim();
  const description = document.getElementById('cfgDescription').value.trim();
  const author = document.getElementById('cfgAuthor').value.trim();
  const authorRole = document.getElementById('cfgAuthorRole').value.trim();
  const authorBio = document.getElementById('cfgAuthorBio').value.trim();
  const email = document.getElementById('cfgEmail').value.trim();
  const githubUrl = document.getElementById('cfgGithubUrl').value.trim();

  const newYaml = `baseURL: "https://daniel-dataflow.github.io/"
languageCode: "ko-kr"
title: "${title}"

pagination:
  pagerSize: 8

taxonomies:
  category: categories
  categories: categories
  tag: tags
  tags: tags

params:
  env: production
  title: "${title}"
  banner_badge: "${bannerBadge}"
  subtitle: "${subtitle}"
  description: "${description}"
  author: "${author}"
  author_role: "${authorRole}"
  author_bio: "${authorBio}"
  author_avatar: "/images/profile.jpg"
  banner_image: "/images/banner.jpg"
  github_url: "${githubUrl}"
  email: "${email}"

  # 네이버 블로그 위젯 설정
  widgets:
    show_profile: true
    show_categories: true
    show_recent_posts: true
    show_tags: true
    show_search: true
    show_stats: true

  # 포스트 설정
  ShowReadingTime: true
  ShowShareButtons: true
  ShowPostNavLinks: true
  ShowBreadCrumbs: true
  ShowCodeCopyButtons: true
  ShowWordCount: true
  ShowToc: true

# 상단 GNB 메뉴바
menu:
  main:
    - identifier: home
      name: "홈"
      url: /
      weight: 10
    - identifier: picksafe
      name: "PickSafe"
      url: /posts/picksafe/
      weight: 20
    - identifier: categories
      name: "카테고리"
      url: /categories/
      weight: 30
    - identifier: tags
      name: "태그 모음"
      url: /tags/
      weight: 40
`;

  try {
    const payload = {
      message: 'Update blog settings hugo.yaml (via In-Repo Web Admin Studio)',
      content: encodeBase64Utf8(newYaml),
      branch: 'main'
    };
    if (sha) payload.sha = sha;

    const res = await ghRequest('contents/hugo.yaml', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    if (res.status === 200 || res.status === 201) {
      statusEl.textContent = '✨ 설정 배포 성공!';
      alert('✨ 블로그 전체 브랜딩 설정이 성공적으로 저장 및 배포되었습니다!');
      closeSettingsModal();
    } else {
      const err = await res.json();
      alert('설정 저장 실패: ' + (err.message || res.statusText));
    }
  } catch (e) {
    alert('설정 저장 중 오류: ' + e.message);
  }
}

// ─── 6. Category Management Modal ───
function openCategoryModal() {
  const modal = document.getElementById('categoryModal');
  const container = document.getElementById('categoryChipsModalContainer');
  modal.style.display = 'flex';

  container.innerHTML = allCategories.map(cat => `
    <span class="cat-badge-chip">📁 ${escapeHtml(cat.slug)}</span>
  `).join('');
}

function closeCategoryModal() {
  document.getElementById('categoryModal').style.display = 'none';
}

async function createNewCategoryOnGitHub() {
  const name = document.getElementById('newCatName').value.trim();
  const slug = document.getElementById('newCatSlug').value.trim().toLowerCase();
  const desc = document.getElementById('newCatDesc').value.trim() || `${name} 아카이브`;

  if (!name || !slug) {
    alert('카테고리 이름과 영문 슬러그를 모두 입력해 주세요.');
    return;
  }

  const cleanSlug = slug.replace(/[^a-z0-9_-]/g, '-');
  const indexContent = `---
title: "${name}"
description: "${desc}"
---
`;

  const targetPath = `content/posts/${cleanSlug}/_index.md`;

  try {
    const payload = {
      message: `Create category: ${name} (via In-Repo Web Admin Studio)`,
      content: encodeBase64Utf8(indexContent),
      branch: 'main'
    };

    const res = await ghRequest(`contents/${targetPath}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    if (res.status === 200 || res.status === 201) {
      alert(`📁 "${name}" 카테고리가 성공적으로 생성되었습니다!`);
      closeCategoryModal();
      await loadCategories();
      document.getElementById('postCategorySelect').value = cleanSlug;
    } else {
      const err = await res.json();
      alert('카테고리 생성 실패: ' + (err.message || res.statusText));
    }
  } catch (e) {
    alert('카테고리 생성 오류: ' + e.message);
  }
}

// ─── 7. Banner & Profile Uploader ───
function openBannerModal() {
  document.getElementById('bannerModal').style.display = 'flex';
}

function closeBannerModal() {
  document.getElementById('bannerModal').style.display = 'none';
}

async function uploadBannerToGitHub(event) {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('bannerUploadStatus');
  statusEl.textContent = '⏳ 업로드 중...';

  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Content = reader.result.split(',')[1];
      const targetPath = 'static/images/banner.jpg';

      // Check SHA
      let sha = null;
      const check = await ghRequest(`contents/${targetPath}`);
      if (check.status === 200) {
        const checkData = await check.json();
        sha = checkData.sha;
      }

      const payload = {
        message: 'Update banner image (via In-Repo Web Admin Studio)',
        content: base64Content,
        branch: 'main'
      };
      if (sha) payload.sha = sha;

      const res = await ghRequest(`contents/${targetPath}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      if (res.status === 200 || res.status === 201) {
        statusEl.textContent = '✅ 배너 교체 완료!';
        alert('✨ 상단 스킨 배너가 성공적으로 변경되었습니다!');
      } else {
        statusEl.textContent = '❌ 실패';
      }
    };
    reader.readAsDataURL(file);
  } catch (e) {
    statusEl.textContent = '❌ 오류: ' + e.message;
  }
}

async function uploadProfileToGitHub(event) {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('profileUploadStatus');
  statusEl.textContent = '⏳ 업로드 중...';

  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Content = reader.result.split(',')[1];
      const targetPath = 'static/images/profile.jpg';

      let sha = null;
      const check = await ghRequest(`contents/${targetPath}`);
      if (check.status === 200) {
        const checkData = await check.json();
        sha = checkData.sha;
      }

      const payload = {
        message: 'Update profile avatar (via In-Repo Web Admin Studio)',
        content: base64Content,
        branch: 'main'
      };
      if (sha) payload.sha = sha;

      const res = await ghRequest(`contents/${targetPath}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      if (res.status === 200 || res.status === 201) {
        statusEl.textContent = '✅ 프로필 교체 완료!';
        alert('✨ 사이드바 프로필 사진이 성공적으로 변경되었습니다!');
      } else {
        statusEl.textContent = '❌ 실패';
      }
    };
    reader.readAsDataURL(file);
  } catch (e) {
    statusEl.textContent = '❌ 오류: ' + e.message;
  }
}

// ─── 8. In-Editor Drag & Drop & Paste Image Upload ───
function initDragAndDrop() {
  const dropZone = document.getElementById('editorDropZone');
  const overlay = document.getElementById('dropOverlay');
  if (!dropZone || !overlay) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      overlay.classList.add('active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      overlay.classList.remove('active');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      uploadInArticleImageToGitHub(files[0]);
    }
  });
}

function initPasteImage() {
  const editor = document.getElementById('markdownEditor');
  if (!editor) return;

  editor.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
      if (item.type.indexOf('image') === 0) {
        const file = item.getAsFile();
        uploadInArticleImageToGitHub(file);
        e.preventDefault();
      }
    }
  });
}

function handleInlineImageUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadInArticleImageToGitHub(file);
  }
}

async function uploadInArticleImageToGitHub(file) {
  const editor = document.getElementById('markdownEditor');
  const ext = file.name.split('.').pop().toLowerCase() || 'png';
  const safeFilename = `img_${Date.now()}.${ext}`;
  const targetPath = `static/blog_images/${safeFilename}`;

  const cursorPos = editor.selectionStart;
  const tempTag = `\n![이미지 업로드 중...](loading)\n`;
  editor.value = editor.value.substring(0, cursorPos) + tempTag + editor.value.substring(cursorPos);
  handleEditorChange();

  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Content = reader.result.split(',')[1];

      const payload = {
        message: `Upload blog image: ${safeFilename} (via In-Repo Web Admin Studio)`,
        content: base64Content,
        branch: 'main'
      };

      const res = await ghRequest(`contents/${targetPath}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      if (res.status === 200 || res.status === 201) {
        const markdownTag = `\n![이미지 설명](/blog_images/${safeFilename})\n`;
        editor.value = editor.value.replace(tempTag, markdownTag);
        handleEditorChange();
      } else {
        alert('이미지 업로드 실패');
        editor.value = editor.value.replace(tempTag, '');
        handleEditorChange();
      }
    };
    reader.readAsDataURL(file);
  } catch (e) {
    alert('이미지 업로드 중 오류: ' + e.message);
    editor.value = editor.value.replace(tempTag, '');
    handleEditorChange();
  }
}

// ─── 9. AI Draft Generator Modal ───
function openAiDraftModal() {
  const modal = document.getElementById('aiModal');
  modal.style.display = 'flex';
  const savedKey = localStorage.getItem('gemini_api_key') || '';
  document.getElementById('geminiApiKeyInput').value = savedKey;
}

function closeAiDraftModal() {
  document.getElementById('aiModal').style.display = 'none';
}

async function generateAiDraftWithGemini() {
  const apiKey = document.getElementById('geminiApiKeyInput').value.trim();
  const notes = document.getElementById('aiSourceNotes').value.trim();
  const statusEl = document.getElementById('aiDraftStatus');

  if (!apiKey) {
    alert('Gemini API Key를 입력해 주세요.');
    return;
  }
  if (!notes) {
    alert('참조할 기술 노트/문서 내용을 입력해 주세요.');
    return;
  }

  localStorage.setItem('gemini_api_key', apiKey);
  statusEl.textContent = '🤖 Gemini 2.5 Flash가 글을 작성 중입니다...';

  const category = document.getElementById('postCategorySelect').value || 'PickSafe';
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const prompt = `너는 스타트업의 수석 소프트웨어 엔지니어이자 전문 테크 블로그 에디터야.
아래 제공되는 개발 노트/의사결정 내용을 바탕으로, 대외 개발자 커뮤니티와 시니어 면접관이 감탄할 만한 "깊이 있는 엔지니어링 기술 블로그 포스팅"을 작성해 줘.

[필수 규칙 1: Frontmatter 규격 - 맨 위와 아래의 '---' 필수]
---
title: "흥미를 유발하는 엔지니어링 중심 제목"
date: "${dateStr}"
categories: ["${category}"]
category: "${category}"
tags: ["Architecture", "Backend", "Optimization"]
---

[필수 규칙 2: 글의 구성과 서식]
- 🎯 문제 정의: 현실적인 문제와 왜 이 기술적 결정이 필요했는지의 배경
- 🏗️ 핵심 아키텍처 및 다이어그램: Mermaid 다이어그램(\`\`\`mermaid ... \`\`\`)을 포함하여 그래픽으로 렌더링되게 할 것!
- ⚖️ 대안 비교 및 Trade-off 분석 (표 또는 깔끔한 리스트)
- 🚀 구현 핵심 코드 및 트러블슈팅 경험 (코드 스니펫)
- 💡 도입 성과 및 엔지니어링 교훈

[원본 개발 노트]:
${notes}
`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (res.status === 200) {
      const data = await res.json();
      const draft = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      document.getElementById('markdownEditor').value = draft;
      handleEditorChange();
      closeAiDraftModal();
      alert('✨ AI 초안 작성이 완료되었습니다! 에디터에서 내용을 다듬어 보세요.');
    } else {
      const err = await res.json();
      alert('AI 생성 실패: ' + (err.error?.message || res.statusText));
    }
  } catch (e) {
    alert('AI 생성 중 오류: ' + e.message);
  } finally {
    statusEl.textContent = '';
  }
}

// ─── 10. Markdown Rendering & Toolbar ───
let previewTimer = null;
function handleEditorChange() {
  isEditorDirty = true;
  const val = document.getElementById('markdownEditor').value;
  document.getElementById('editorCharCount').textContent = `${val.length.toLocaleString()}자`;

  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(renderLivePreview, 150);
}

function renderLivePreview() {
  const editor = document.getElementById('markdownEditor');
  const viewport = document.getElementById('previewViewport');
  if (!editor || !viewport) return;

  const raw = editor.value.trim();
  if (!raw) {
    viewport.innerHTML = '<p style="color: #94a3b8; text-align: center; margin-top: 50px;">마크다운을 입력하시면 네이버 블로그 스타일로 실시간 렌더링됩니다.</p>';
    return;
  }

  // Remove frontmatter for preview
  let body = raw;
  let title = '';
  let cat = '';
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    body = raw.replace(fm[0], '');
    const tm = fm[1].match(/title:\s*["']?(.*?)["']?\s*$/m);
    const cm = fm[1].match(/category:\s*["']?(.*?)["']?\s*$/m);
    if (tm) title = tm[1];
    if (cm) cat = cm[1];
  }

  if (typeof marked !== 'undefined') {
    marked.setOptions({
      gfm: true,
      breaks: true,
      highlight: function(code, lang) {
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
          try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
        }
        return code;
      }
    });

    let headerHtml = '';
    if (title) {
      headerHtml = `
        <div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 20px;">
          <span style="font-size: 0.8rem; font-weight: 700; color: #03c75a;">${escapeHtml(cat || 'Tech Blog')}</span>
          <h1 style="font-size: 1.6rem; font-weight: 800; color: #111; margin-top: 6px;">${escapeHtml(title)}</h1>
        </div>
      `;
    }

    viewport.innerHTML = headerHtml + marked.parse(body);

    // Render Mermaid diagrams
    if (typeof mermaid !== 'undefined') {
      const mermaidBlocks = viewport.querySelectorAll('code.language-mermaid, pre.mermaid');
      mermaidBlocks.forEach((block, idx) => {
        const graphDef = block.textContent;
        const container = document.createElement('div');
        container.className = 'mermaid-container';
        const id = `mermaid-prev-${idx}-${Date.now()}`;
        try {
          mermaid.render(id, graphDef).then(({ svg }) => {
            container.innerHTML = svg;
            block.parentNode.replaceChild(container, block);
          }).catch(e => {});
        } catch (e) {}
      });
    }
  } else {
    viewport.innerText = body;
  }
}

function insertMarkdown(prefix, suffix, defaultText) {
  const editor = document.getElementById('markdownEditor');
  if (!editor) return;

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.substring(start, end) || defaultText;

  editor.value = editor.value.substring(0, start) + prefix + selected + suffix + editor.value.substring(end);
  editor.selectionStart = start + prefix.length;
  editor.selectionEnd = start + prefix.length + selected.length;
  editor.focus();
  handleEditorChange();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
