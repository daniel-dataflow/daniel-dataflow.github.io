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

function showToast(message) {
  let toast = document.getElementById('nb-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'nb-toast';
    toast.className = 'nb-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
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

function decodeBase64Utf8(base64Str) {
  try {
    const binString = atob(base64Str.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return atob(base64Str);
  }
}

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
      const dirs = items.filter(item => item.type === 'dir' && !item.name.startsWith('.'));
      
      allCategories = await Promise.all(dirs.map(async item => {
        let name = item.name;
        let desc = `${item.name} 아카이브`;
        let project_url = '';
        let indexSha = null;

        try {
          const idxRes = await ghRequest(`contents/${item.path}/_index.md`);
          if (idxRes.status === 200) {
            const idxData = await idxRes.json();
            indexSha = idxData.sha;
            const idxText = decodeBase64Utf8(idxData.content);
            const tm = idxText.match(/title:\s*["']?(.*?)["']?\s*$/m);
            const dm = idxText.match(/description:\s*["']?(.*?)["']?\s*$/m);
            const pm = idxText.match(/project_url:\s*["']?(.*?)["']?\s*$/m);
            if (tm && tm[1]) name = tm[1].trim();
            if (dm && dm[1]) desc = dm[1].trim();
            if (pm && pm[1]) project_url = pm[1].trim();
          }
        } catch (e) {}

        return {
          slug: item.name,
          name: name,
          desc: desc,
          project_url: project_url,
          indexSha: indexSha,
          path: item.path
        };
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

let expandedFolders = new Set();
let isFoldersInitialized = false;

function extractYearMonth(filename) {
  const m = filename.match(/^(\d{4})[-./](\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  return '기타';
}

function renderPostsList() {
  const listContainer = document.getElementById('sidebarItemsList');
  if (!listContainer) return;

  if (allPublishedPosts.length === 0) {
    listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">발행된 글이 없습니다.</div>';
    return;
  }

  // 1. Group posts by Year-Month (YYYY-MM)
  const groups = {};
  allPublishedPosts.forEach(post => {
    const ym = extractYearMonth(post.name);
    if (!groups[ym]) groups[ym] = [];
    groups[ym].push(post);
  });

  // 2. Sort group keys in reverse chronological order (e.g. 2026-07, 2026-01)
  const sortedYmKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  // Sort posts inside each group in reverse order
  sortedYmKeys.forEach(ym => {
    groups[ym].sort((a, b) => b.name.localeCompare(a.name));
  });

  // Initialize expanded state (expand all on first load)
  if (!isFoldersInitialized) {
    sortedYmKeys.forEach(ym => expandedFolders.add(ym));
    isFoldersInitialized = true;
  }

  // 3. Header toolbar with count and [펼치기] / [접기] buttons
  let html = `
    <div class="sidebar-folder-toolbar">
      <span class="folder-total-count">기발행 ${allPublishedPosts.length}건</span>
      <div class="folder-action-btns">
        <button type="button" class="btn-folder-toggle" onclick="expandAllFolders()">펼치기</button>
        <button type="button" class="btn-folder-toggle" onclick="collapseAllFolders()">접기</button>
      </div>
    </div>
  `;

  // 4. Render Year-Month Accordion Folders
  sortedYmKeys.forEach(ym => {
    const posts = groups[ym];
    const isExpanded = expandedFolders.has(ym);

    const postsHtml = posts.map(post => `
      <div class="post-item-card ${currentEditingPost && currentEditingPost.path === post.path ? 'active' : ''}" data-title="${escapeHtml(post.name.toLowerCase())}" data-cat="${escapeHtml(post.category.toLowerCase())}">
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

    html += `
      <div class="ym-folder-group" id="folder-group-${ym}" data-ym="${ym}">
        <div class="ym-folder-header" onclick="toggleYmFolder('${ym}')">
          <div class="ym-folder-title">
            <i class="fa-solid fa-caret-right ym-arrow ${isExpanded ? 'rotated' : ''}" id="arrow-${ym}"></i>
            <i class="fa-solid fa-folder ym-folder-icon"></i>
            <span class="ym-name">${ym}</span>
          </div>
          <span class="ym-count-badge">${posts.length}</span>
        </div>
        <div class="ym-folder-items" id="items-${ym}" style="display: ${isExpanded ? 'flex' : 'none'};">
          ${postsHtml}
        </div>
      </div>
    `;
  });

  listContainer.innerHTML = html;
}

function toggleYmFolder(ym) {
  const itemsEl = document.getElementById(`items-${ym}`);
  const arrowEl = document.getElementById(`arrow-${ym}`);
  if (!itemsEl) return;

  const isCurrentlyOpen = expandedFolders.has(ym);
  if (isCurrentlyOpen) {
    expandedFolders.delete(ym);
    itemsEl.style.display = 'none';
    if (arrowEl) arrowEl.classList.remove('rotated');
  } else {
    expandedFolders.add(ym);
    itemsEl.style.display = 'flex';
    if (arrowEl) arrowEl.classList.add('rotated');
  }
}

function expandAllFolders() {
  document.querySelectorAll('.ym-folder-group').forEach(group => {
    const ym = group.dataset.ym;
    if (ym) {
      expandedFolders.add(ym);
      const itemsEl = document.getElementById(`items-${ym}`);
      const arrowEl = document.getElementById(`arrow-${ym}`);
      if (itemsEl) itemsEl.style.display = 'flex';
      if (arrowEl) arrowEl.classList.add('rotated');
    }
  });
}

function collapseAllFolders() {
  expandedFolders.clear();
  document.querySelectorAll('.ym-folder-group').forEach(group => {
    const ym = group.dataset.ym;
    if (ym) {
      const itemsEl = document.getElementById(`items-${ym}`);
      const arrowEl = document.getElementById(`arrow-${ym}`);
      if (itemsEl) itemsEl.style.display = 'none';
      if (arrowEl) arrowEl.classList.remove('rotated');
    }
  });
}

function filterPostsList() {
  const q = document.getElementById('postSearchInput').value.toLowerCase().trim();
  const groups = document.querySelectorAll('.ym-folder-group');

  groups.forEach(group => {
    const cards = group.querySelectorAll('.post-item-card');
    let visibleInGroup = 0;

    cards.forEach(card => {
      const text = (card.dataset.title || '') + ' ' + (card.dataset.cat || '');
      const match = text.includes(q);
      card.style.display = match ? 'flex' : 'none';
      if (match) visibleInGroup++;
    });

    if (q) {
      if (visibleInGroup > 0) {
        group.style.display = 'block';
        const ym = group.dataset.ym;
        const itemsEl = document.getElementById(`items-${ym}`);
        const arrowEl = document.getElementById(`arrow-${ym}`);
        if (itemsEl) itemsEl.style.display = 'flex';
        if (arrowEl) arrowEl.classList.add('rotated');
      } else {
        group.style.display = 'none';
      }
    } else {
      group.style.display = 'block';
      const ym = group.dataset.ym;
      const isExpanded = expandedFolders.has(ym);
      const itemsEl = document.getElementById(`items-${ym}`);
      const arrowEl = document.getElementById(`arrow-${ym}`);
      if (itemsEl) itemsEl.style.display = isExpanded ? 'flex' : 'none';
      if (arrowEl) {
        if (isExpanded) arrowEl.classList.add('rotated');
        else arrowEl.classList.remove('rotated');
      }
    }
  });
}

function switchSidebarTab(tab) {
  const tabPosts = document.getElementById('tabPosts');
  const tabCats = document.getElementById('tabCategories');

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

  let html = `
    <div class="sidebar-folder-toolbar">
      <span class="folder-total-count">카테고리 ${allCategories.length}개</span>
      <div class="folder-action-btns">
        <button type="button" class="btn-folder-toggle" onclick="openCategoryModal('__new__')" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.3);">➕ 카테고리 추가</button>
      </div>
    </div>
  `;

  html += allCategories.map(cat => `
    <div class="post-item-card" onclick="openCategoryModal('${cat.slug}')" style="flex-direction: row; align-items: center; justify-content: space-between;">
      <div class="post-item-info">
        <div class="post-item-title">📁 ${escapeHtml(cat.name)} <span style="font-size: 0.72rem; color: #94a3b8; font-weight: normal;">(${escapeHtml(cat.slug)})</span></div>
        <div class="post-item-meta" style="flex-direction: column; align-items: flex-start; gap: 3px;">
          <span>${escapeHtml(cat.desc || 'content/posts/' + cat.slug)}</span>
          ${cat.project_url ? `<span style="color: #38bdf8; font-size: 0.72rem;"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${escapeHtml(cat.project_url)}</span>` : ''}
        </div>
      </div>
      <button type="button" class="btn-folder-toggle" title="카테고리 수정" style="padding: 4px 8px; font-size: 0.75rem;">
        <i class="fa-solid fa-pen-to-square"></i>
      </button>
    </div>
  `).join('');

  listContainer.innerHTML = html;
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

// ─── Post Filename & Date Resolvers (Strictly from Content) ───
function extractDateFromContent(content, fallbackDate = '') {
  if (!content) {
    if (fallbackDate) {
      const fnM = fallbackDate.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);
      if (fnM) return `${fnM[1]}-${fnM[2]}-${fnM[3]}`;
    }
    return new Date().toISOString().substring(0, 10);
  }

  // 1. Frontmatter date field (e.g. date: "2026-01-30 09:00:00", date: 2026.01.30)
  const fmMatch = content.match(/^date:\s*["']?(\d{4})[-./](\d{2})[-./](\d{2})/im);
  if (fmMatch) return `${fmMatch[1]}-${fmMatch[2]}-${fmMatch[3]}`;

  // 2. Explicit date label in text (e.g. 작성일: 2026.01.30, 날짜: 2026-01-30)
  const labelMatch = content.match(/(?:작성일|일자|날짜|date)[:：]?\s*["']?(\d{4})[-./](\d{2})[-./](\d{2})/i);
  if (labelMatch) return `${labelMatch[1]}-${labelMatch[2]}-${labelMatch[3]}`;

  // 3. Date range pattern (e.g. 2026.01.26 ~ 2026.01.30) -> End date prioritized
  const rangeEndMatch = content.match(/[~-]\s*(\d{4})[-./](\d{2})[-./](\d{2})/);
  if (rangeEndMatch) return `${rangeEndMatch[1]}-${rangeEndMatch[2]}-${rangeEndMatch[3]}`;

  const rangeStartMatch = content.match(/\(?(\d{4})[-./](\d{2})[-./](\d{2})\s*[~-]/);
  if (rangeStartMatch) return `${rangeStartMatch[1]}-${rangeStartMatch[2]}-${rangeStartMatch[3]}`;

  // 4. Fallback from existing filename
  if (fallbackDate) {
    const fnM = fallbackDate.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);
    if (fnM) return `${fnM[1]}-${fnM[2]}-${fnM[3]}`;
  }

  return new Date().toISOString().substring(0, 10);
}

function extractTitleFromContent(content, fallbackTitle = 'post') {
  if (!content) return fallbackTitle;

  // 1. Frontmatter title
  const fmTitleMatch = content.match(/^title:\s*["']?(.*?)["']?\s*$/im);
  if (fmTitleMatch && fmTitleMatch[1].trim()) {
    const t = fmTitleMatch[1].trim().replace(/^["']|["']$/g, '');
    if (t && t !== '새 글 제목을 입력하세요') return t;
  }

  // 2. H1 heading (# ...)
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match && h1Match[1].trim()) {
    const t = h1Match[1].trim();
    if (!t.match(/^[\(\[]?\d{4}[-./]\d{2}/)) return t;
  }

  // 3. H2 heading (## ...)
  const h2Match = content.match(/^##\s+(.+)$/m);
  if (h2Match && h2Match[1].trim()) {
    const t = h2Match[1].trim();
    if (!t.match(/^[\(\[]?\d{4}[-./]\d{2}/)) return t;
  }

  return fallbackTitle;
}

function extractPostFilename(content, currentFilename = '') {
  const dateStr = extractDateFromContent(content, currentFilename);
  let rawTitle = extractTitleFromContent(content);

  if ((rawTitle === 'post' || !rawTitle) && currentFilename && !currentFilename.startsWith('new-post-') && !currentFilename.startsWith('post_')) {
    const cleanFn = currentFilename.replace(/^\d{4}[-./]\d{2}[-./]\d{2}-?/, '').replace(/\.md$/, '');
    if (cleanFn) rawTitle = cleanFn;
  }

  let safeTitle = rawTitle.replace(/[\[\]"'()]/g, '');
  safeTitle = safeTitle.replace(/[^\w가-힣\s-]/g, '');
  safeTitle = safeTitle.replace(/[\s_]+/g, '-');
  safeTitle = safeTitle.replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 50) || 'post';

  return `${dateStr}-${safeTitle}.md`;
}

async function publishPostToGitHub() {
  const content = document.getElementById('markdownEditor').value.trim();
  const category = document.getElementById('postCategorySelect').value || 'picksafe';

  if (!content) {
    alert('에디터에 발행할 마크다운 내용이 없습니다.');
    return;
  }

  // Calculate canonical filename strictly from content's date and title
  const oldFilename = currentEditingPost ? currentEditingPost.filename : '';
  const filename = extractPostFilename(content, oldFilename);
  const targetPath = `content/posts/${category}/${filename}`;

  if (!confirm(`다음 포스트를 GitHub [${category}] 카테고리에 배포하시겠습니까?\n\n생성된 파일명: ${filename}\n경로: ${targetPath}`)) {
    return;
  }

  const btn = document.getElementById('btnPublish');
  const origText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 배포 중...';
  btn.disabled = true;

  try {
    let sha = null;
    if (currentEditingPost && currentEditingPost.filename === filename) {
      sha = currentEditingPost.sha;
    } else {
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
      const putData = await putRes.json();

      // If filename changed, remove the old file from GitHub
      if (currentEditingPost && currentEditingPost.path && currentEditingPost.filename !== filename) {
        try {
          await ghRequest(`contents/${currentEditingPost.path}`, {
            method: 'DELETE',
            body: JSON.stringify({
              message: `Rename cleanup: delete old ${currentEditingPost.filename} after publishing ${filename}`,
              sha: currentEditingPost.sha,
              branch: 'main'
            })
          });
          console.log(`Deleted old file: ${currentEditingPost.path}`);
        } catch (delErr) {
          console.warn('이전 파일 삭제 경고:', delErr);
        }
      }

      currentEditingPost = {
        path: targetPath,
        sha: putData.content?.sha || '',
        category: category,
        filename: filename
      };

      document.getElementById('currentDocStatusBadge').textContent = `[${category}] ${filename}`;
      alert(`🎉 포스트가 GitHub [${category}] 카테고리에 성공적으로 배포되었습니다!\n\n파일명: ${filename}\n잠시 후 https://daniel-dataflow.github.io 에 자동 반영됩니다.`);
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
      document.getElementById('cfgPortfolioUrl').value = getField(/portfolio_url:\s*["']?(.*?)["']?\s*$/m, 'https://daniel-dataflow.github.io');
      document.getElementById('cfgGithubUrl').value = getField(/github_url:\s*["']?(.*?)["']?\s*$/m, '');
      document.getElementById('cfgEmail').value = getField(/email:\s*["']?(.*?)["']?\s*$/m, '');

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
  const portfolioUrl = document.getElementById('cfgPortfolioUrl').value.trim() || 'https://daniel-dataflow.github.io';
  const githubUrl = document.getElementById('cfgGithubUrl').value.trim();
  const email = document.getElementById('cfgEmail').value.trim();

  const newYaml = `baseURL: "https://daniel-dataflow.github.io/"
languageCode: "ko-kr"
title: "${title}"

pagination:
  pagerSize: 8

outputs:
  home:
    - HTML
    - RSS
    - JSON

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
  portfolio_url: "${portfolioUrl}"
  github_url: "${githubUrl}"
  email: "${email}"

  # 네이버 블로그 위젯 설정
  widgets:
    show_profile: true
    show_categories: true
    show_recent_posts: true
    show_tags: true
    show_search: true

  # 포스트 설정
  ShowReadingTime: true
  ShowShareButtons: true
  ShowPostNavLinks: true
  ShowBreadCrumbs: true
  ShowCodeCopyButtons: true
  ShowWordCount: true
  ShowToc: true

# 상단 GNB 메뉴바 (카테고리 전체보기로 단일화하여 모든 카테고리 균등 대우)
menu:
  main:
    - identifier: home
      name: "홈"
      url: /
      weight: 10
    - identifier: categories
      name: "카테고리"
      url: /categories/
      weight: 20
    - identifier: tags
      name: "태그 모음"
      url: /tags/
      weight: 30
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
let currentEditingCategorySlug = null;

function openCategoryModal(targetSlug = null) {
  const modal = document.getElementById('categoryModal');
  const container = document.getElementById('categoryChipsModalContainer');
  modal.style.display = 'flex';
  document.getElementById('catModalStatus').textContent = '';

  renderCategoryModalChips(targetSlug);

  if (targetSlug === '__new__' || allCategories.length === 0) {
    switchToNewCategoryMode();
  } else {
    const slugToSelect = targetSlug || (allCategories[0] ? allCategories[0].slug : null);
    if (slugToSelect) {
      selectCategoryForEditing(slugToSelect);
    } else {
      switchToNewCategoryMode();
    }
  }
}

function renderCategoryModalChips(activeSlug) {
  const container = document.getElementById('categoryChipsModalContainer');
  if (!container) return;

  container.innerHTML = allCategories.map(cat => {
    const isActive = cat.slug === activeSlug;
    return `
      <span class="cat-badge-chip ${isActive ? 'active' : ''}" onclick="selectCategoryForEditing('${cat.slug}')" style="cursor: pointer; ${isActive ? 'background: #0284c7; color: #fff;' : ''}">
        📁 ${escapeHtml(cat.name)} <span style="font-size: 0.72rem; opacity: 0.8;">(${escapeHtml(cat.slug)})</span>
      </span>
    `;
  }).join('') + `
    <span class="cat-badge-chip" onclick="switchToNewCategoryMode()" style="cursor: pointer; border-style: dashed; color: #38bdf8;">
      ➕ 새 카테고리 추가
    </span>
  `;
}

function selectCategoryForEditing(slug) {
  currentEditingCategorySlug = slug;
  renderCategoryModalChips(slug);

  const cat = allCategories.find(c => c.slug === slug);
  if (!cat) return;

  document.getElementById('catNameInput').value = cat.name || slug;
  document.getElementById('catSlugInput').value = cat.slug;
  document.getElementById('catSlugInput').disabled = true;
  document.getElementById('catDescInput').value = cat.desc || '';
  document.getElementById('catProjectUrlInput').value = cat.project_url || '';

  const delBtn = document.getElementById('btnDeleteCategory');
  if (delBtn) delBtn.style.display = 'inline-flex';

  const titleEl = document.getElementById('catFormModeTitle');
  if (titleEl) {
    titleEl.innerHTML = `
      <span><i class="fa-solid fa-pen-to-square"></i> '${escapeHtml(cat.name)}' 카테고리 정보 수정</span>
      <button type="button" class="btn-folder-toggle" onclick="switchToNewCategoryMode()" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.3);">➕ 새 카테고리 추가</button>
    `;
  }

  const btn = document.getElementById('btnSaveCategory');
  if (btn) {
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 카테고리 수정 저장 & GitHub 배포';
  }
}

function switchToNewCategoryMode() {
  currentEditingCategorySlug = null;
  renderCategoryModalChips('__new__');

  document.getElementById('catNameInput').value = '';
  document.getElementById('catSlugInput').value = '';
  document.getElementById('catSlugInput').disabled = false;
  document.getElementById('catDescInput').value = '';
  document.getElementById('catProjectUrlInput').value = '';

  const delBtn = document.getElementById('btnDeleteCategory');
  if (delBtn) delBtn.style.display = 'none';

  const titleEl = document.getElementById('catFormModeTitle');
  if (titleEl) {
    titleEl.innerHTML = `<span><i class="fa-solid fa-plus"></i> 새 카테고리 생성</span>`;
  }

  const btn = document.getElementById('btnSaveCategory');
  if (btn) {
    btn.innerHTML = '<i class="fa-solid fa-plus"></i> 카테고리 생성 & GitHub 연동';
  }
}

function closeCategoryModal() {
  document.getElementById('categoryModal').style.display = 'none';
}

function closeCatDeleteModal() {
  const modal = document.getElementById('catDeleteModal');
  if (modal) modal.style.display = 'none';
}

function openCategoryDeleteDialog() {
  const slug = (currentEditingCategorySlug || document.getElementById('catSlugInput')?.value || '').trim();
  if (!slug) {
    alert('삭제할 카테고리를 먼저 선택해 주세요.');
    return;
  }

  let cat = (allCategories || []).find(c => c.slug === slug);
  if (!cat) {
    const name = document.getElementById('catNameInput')?.value.trim() || slug;
    cat = { name: name, slug: slug };
  }

  const postsInCat = (allPublishedPosts || []).filter(p => {
    return p.category_slug === slug || 
           (p.path && p.path.includes(`/${slug}/`)) ||
           (p.category && p.category.toLowerCase() === (cat.name || '').toLowerCase());
  });

  const warningEl = document.getElementById('catDeleteWarningText');
  const migrationBox = document.getElementById('catMigrationBox');
  const targetSelect = document.getElementById('catMigrationTargetSelect');
  const confirmBtn = document.getElementById('btnConfirmCatDelete');
  const deleteModal = document.getElementById('catDeleteModal');

  const otherCategories = (allCategories || []).filter(c => c.slug !== slug);

  if (postsInCat.length === 0) {
    if (warningEl) {
      warningEl.innerHTML = `현재 <b>'${escapeHtml(cat.name)}'</b> 카테고리에 속한 글이 없습니다.<br><br>정말로 이 카테고리(폴더 및 _index.md)를 완전히 삭제하시겠습니까?`;
    }
    if (migrationBox) migrationBox.style.display = 'none';
    if (confirmBtn) confirmBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> 카테고리 즉시 삭제';
  } else {
    if (warningEl) {
      warningEl.innerHTML = `⚠️ <b>'${escapeHtml(cat.name)}'</b> 카테고리에 총 <strong style="color: #38bdf8;">${postsInCat.length}개</strong>의 작성된 글이 있습니다.<br><br>기존 글들이 유실되지 않도록 이동할 대상 카테고리를 지정해 주세요.`;
    }
    if (migrationBox) migrationBox.style.display = 'block';
    
    if (targetSelect) {
      if (otherCategories.length === 0) {
        targetSelect.innerHTML = `<option value="tech">일반 기술 / Tech (기본 카테고리)</option>`;
      } else {
        targetSelect.innerHTML = otherCategories.map(c => `
          <option value="${c.slug}">${escapeHtml(c.name)} (${escapeHtml(c.slug)})</option>
        `).join('');
      }
    }
    if (confirmBtn) {
      confirmBtn.innerHTML = `<i class="fa-solid fa-arrows-split-up-and-left"></i> ${postsInCat.length}개 글 이동 및 카테고리 삭제`;
    }
  }

  if (deleteModal) {
    deleteModal.style.display = 'flex';
  }
}

async function executeCategoryDeletion() {
  const slug = (currentEditingCategorySlug || document.getElementById('catSlugInput')?.value || '').trim();
  if (!slug) {
    alert('삭제할 카테고리 슬러그를 찾을 수 없습니다.');
    return;
  }
  let cat = (allCategories || []).find(c => c.slug === slug);
  if (!cat) {
    const name = document.getElementById('catNameInput')?.value.trim() || slug;
    cat = { name: name, slug: slug };
  }

  const pat = githubPat || localStorage.getItem('gh_admin_pat');

  if (!pat) {
    alert('GitHub 인증 토큰이 없습니다. 다시 로그인해 주세요.');
    return;
  }

  const postsInCat = (allPublishedPosts || []).filter(p => {
    return p.category_slug === slug || 
           (p.path && p.path.includes(`/${slug}/`)) ||
           (p.category && p.category.toLowerCase() === (cat.name || '').toLowerCase());
  });

  const confirmBtn = document.getElementById('btnConfirmCatDelete');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 삭제 및 글 이전 처리 중...';
  }

  try {
    const targetSelect = document.getElementById('catMigrationTargetSelect');
    const targetSlug = (targetSelect && targetSelect.value) ? targetSelect.value : 'tech';
    const targetCat = (allCategories || []).find(c => c.slug === targetSlug) || { name: targetSlug, slug: targetSlug };

    // 1. Migrate posts if any
    for (const post of postsInCat) {
      if (!post.path) continue;
      const fileRes = await fetch(`${API_BASE}/contents/${post.path}`, {
        headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' }
      });
      if (fileRes.ok) {
        const fileData = await fileRes.json();
        const content = decodeURIComponent(escape(atob(fileData.content.replace(/\s/g, ''))));
        
        // Update frontmatter category
        const updatedContent = content.replace(/category:\s*["']?.*?["']?\s*$/m, `category: "${targetCat.name}"`);
        const filename = post.path.split('/').pop();
        const newPath = `content/posts/${targetSlug}/${filename}`;

        // Create in new location
        const b64New = btoa(unescape(encodeURIComponent(updatedContent)));
        await fetch(`${API_BASE}/contents/${newPath}`, {
          method: 'PUT',
          headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
          body: JSON.stringify({
            message: `Migrate post '${post.title}' from '${slug}' to '${targetSlug}' (via Blog Studio)`,
            content: b64New,
            branch: 'main'
          })
        });

        // Delete old file
        await fetch(`${API_BASE}/contents/${post.path}`, {
          method: 'DELETE',
          headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
          body: JSON.stringify({
            message: `Delete old post path '${post.path}' after migration`,
            sha: fileData.sha,
            branch: 'main'
          })
        });
      }
    }

    // 2. Delete _index.md of the category
    const indexPath = `content/posts/${slug}/_index.md`;
    const indexRes = await fetch(`${API_BASE}/contents/${indexPath}`, {
      headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (indexRes.ok) {
      const indexData = await indexRes.json();
      await fetch(`${API_BASE}/contents/${indexPath}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
        body: JSON.stringify({
          message: `Delete category '${cat.name}' (${slug}) (via Blog Studio)`,
          sha: indexData.sha,
          branch: 'main'
        })
      });
    }

    closeCatDeleteModal();
    closeCategoryModal();
    alert(`🎉 '${cat.name}' 카테고리가 성공적으로 삭제되었습니다.`);

    // Reload posts and categories
    await loadCategories();
    await loadPublishedPosts();
  } catch (err) {
    alert('카테고리 삭제 및 글 이전 중 오류 발생: ' + err.message);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> 글 이동 및 카테고리 삭제 실행';
    }
  }
}

async function saveCategoryOnGitHub() {
  const name = document.getElementById('catNameInput').value.trim();
  const slug = (document.getElementById('catSlugInput').value || currentEditingCategorySlug || '').trim().toLowerCase();
  const desc = document.getElementById('catDescInput').value.trim() || `${name} 아카이브`;
  const projectUrl = document.getElementById('catProjectUrlInput').value.trim();

  if (!name || !slug) {
    alert('카테고리 이름과 영문 슬러그를 모두 입력해 주세요.');
    return;
  }

  const cleanSlug = slug.replace(/[^a-z0-9_-]/g, '-');
  let indexContent = `---\ntitle: "${name}"\ndescription: "${desc}"\n`;
  if (projectUrl) {
    indexContent += `project_url: "${projectUrl}"\n`;
  }
  indexContent += `---\n`;

  const targetPath = `content/posts/${cleanSlug}/_index.md`;
  const statusEl = document.getElementById('catModalStatus');
  statusEl.textContent = '⏳ GitHub 저장 중...';

  try {
    let sha = null;
    const catObj = allCategories.find(c => c.slug === cleanSlug);
    if (catObj && catObj.indexSha) {
      sha = catObj.indexSha;
    } else {
      const checkRes = await ghRequest(`contents/${targetPath}`);
      if (checkRes.status === 200) {
        const checkData = await checkRes.json();
        sha = checkData.sha;
      }
    }

    const payload = {
      message: `Update category: ${name} (via In-Repo Web Admin Studio)`,
      content: encodeBase64Utf8(indexContent),
      branch: 'main'
    };
    if (sha) payload.sha = sha;

    const res = await ghRequest(`contents/${targetPath}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    if (res.status === 200 || res.status === 201) {
      alert(`📁 "${name}" 카테고리 정보가 성공적으로 저장 및 배포되었습니다!`);
      closeCategoryModal();
      await loadCategories();
      document.getElementById('postCategorySelect').value = cleanSlug;
      if (document.getElementById('tabCategories').classList.contains('active')) {
        renderCategoriesList();
      }
    } else {
      const err = await res.json();
      alert('카테고리 저장 실패: ' + (err.message || res.statusText));
    }
  } catch (e) {
    alert('카테고리 저장 오류: ' + e.message);
  } finally {
    statusEl.textContent = '';
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

window.blogImagePreviewCache = window.blogImagePreviewCache || {};

async function uploadInArticleImageToGitHub(file) {
  const editor = document.getElementById('markdownEditor');
  const ext = file.name.split('.').pop().toLowerCase() || 'png';
  const safeFilename = `img_${Date.now()}.${ext}`;
  const targetPath = `static/blog_images/${safeFilename}`;

  // Instant local Blob Preview Cache (0ms instant preview)
  const blobUrl = URL.createObjectURL(file);
  window.blogImagePreviewCache[`/blog_images/${safeFilename}`] = blobUrl;
  window.blogImagePreviewCache[`/static/blog_images/${safeFilename}`] = blobUrl;
  window.blogImagePreviewCache[safeFilename] = blobUrl;

  const cursorPos = editor.selectionStart;
  const tempTag = `\n![이미지 업로드 중...](data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="32" viewBox="0 0 160 32"><rect width="160" height="32" rx="6" fill="%230f172a"/><text x="10" y="20" fill="%2303c75a" font-family="sans-serif" font-size="12" font-weight="bold">⏳ 업로드 중...</text></svg>)\n`;
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

// ─── 9. AI Draft Generator Modal & Prompt Template Settings ───
const DEFAULT_GEMINI_PROMPT = `너는 스타트업의 수석 소프트웨어 엔지니어이자 전문 테크 블로그 에디터야.
아래 제공되는 개발 노트/의사결정 내용을 바탕으로, 대외 개발자 커뮤니티와 시니어 면접관이 감탄할 만한 "깊이 있는 엔지니어링 기술 블로그 포스팅"을 작성해 줘.

[필수 규칙 1: Frontmatter 규격 - 맨 위와 아래의 '---' 필수]
---
title: "흥미를 유발하는 엔지니어링 중심 제목"
date: "{{date}}"
categories: ["{{category}}"]
category: "{{category}}"
tags: ["Architecture", "Backend", "Optimization"]
---

[필수 규칙 2: 글의 구성과 서식]
- 🎯 문제 정의: 현실적인 문제와 왜 이 기술적 결정이 필요했는지의 배경
- 🏗️ 핵심 아키텍처 및 다이어그램: Mermaid 다이어그램(\`\`\`mermaid ... \`\`\`)을 포함하여 그래픽으로 렌더링되게 할 것!
- ⚖️ 대안 비교 및 Trade-off 분석 (표 또는 깔끔한 리스트)
- 🚀 구현 핵심 코드 및 트러블슈팅 경험 (코드 스니펫)
- 💡 도입 성과 및 엔지니어링 교훈

[원본 개발 노트]:
{{notes}}
`;

function openAiDraftModal() {
  const modal = document.getElementById('aiModal');
  modal.style.display = 'flex';

  const savedKey = localStorage.getItem('gemini_api_key') || '';
  const keyInput = document.getElementById('geminiApiKeyInput');
  if (keyInput) keyInput.value = savedKey;

  const badge = document.getElementById('apiKeySaveBadge');
  if (badge) badge.textContent = savedKey ? '✓ 브라우저에 저장됨' : '';

  // Model Selection (Default: gemini-3.5-flash)
  const savedModel = localStorage.getItem('gemini_selected_model') || 'gemini-3.5-flash';
  const modelSelect = document.getElementById('geminiModelSelect');
  const customInput = document.getElementById('geminiCustomModelInput');

  if (modelSelect) {
    const hasOption = Array.from(modelSelect.options).some(opt => opt.value === savedModel);
    if (hasOption) {
      modelSelect.value = savedModel;
      if (customInput) customInput.style.display = 'none';
    } else {
      modelSelect.value = '__custom__';
      if (customInput) {
        customInput.style.display = 'block';
        customInput.value = savedModel;
      }
    }
  }

  const savedPrompt = localStorage.getItem('gemini_prompt_template') || DEFAULT_GEMINI_PROMPT;
  const promptInput = document.getElementById('geminiPromptTemplateInput');
  if (promptInput) promptInput.value = savedPrompt;

  // Auto-detect editor text context
  const editorText = (document.getElementById('markdownEditor')?.value || '').trim();
  const contextTextEl = document.getElementById('aiEditorContextText');
  const extraLabel = document.getElementById('aiExtraPromptLabel');

  if (editorText) {
    if (contextTextEl) {
      contextTextEl.innerHTML = `📄 <b>현재 에디터 본문(총 ${editorText.length.toLocaleString()}자)</b>이 AI 생성 시 자동 참조됩니다.`;
    }
    if (extraLabel) {
      extraLabel.textContent = '💬 추가 요청사항 / 강조할 포인트 (선택 사항 - 비워두셔도 자동 작성됩니다):';
    }
  } else {
    if (contextTextEl) {
      contextTextEl.innerHTML = `💡 에디터가 비어 있습니다. 아래에 기술 노트나 주제를 입력해 주세요.`;
    }
    if (extraLabel) {
      extraLabel.textContent = '📝 참조할 개발 노트 / 기술 요약 내용:';
    }
  }
}

function handleModelChange(val) {
  const customInput = document.getElementById('geminiCustomModelInput');
  if (val === '__custom__') {
    if (customInput) {
      customInput.style.display = 'block';
      customInput.focus();
    }
  } else {
    if (customInput) customInput.style.display = 'none';
    localStorage.setItem('gemini_selected_model', val);
  }
}

function closeAiDraftModal() {
  document.getElementById('aiModal').style.display = 'none';
}

function saveGeminiApiKeyAuto(val) {
  const cleanKey = val.trim();
  localStorage.setItem('gemini_api_key', cleanKey);
  const badge = document.getElementById('apiKeySaveBadge');
  if (badge) badge.textContent = cleanKey ? '✓ 브라우저에 저장됨' : '';
}

function saveAiPromptSettingsManual() {
  const key = (document.getElementById('geminiApiKeyInput')?.value || '').trim();
  const prompt = (document.getElementById('geminiPromptTemplateInput')?.value || '').trim();
  const modelSelect = document.getElementById('geminiModelSelect');
  let model = modelSelect ? modelSelect.value : 'gemini-3.5-flash';
  if (model === '__custom__') {
    model = (document.getElementById('geminiCustomModelInput')?.value || '').trim() || 'gemini-3.5-flash';
  }

  if (!prompt) {
    alert('프롬프트 템플릿 내용을 입력해 주세요.');
    return;
  }

  localStorage.setItem('gemini_api_key', key);
  localStorage.setItem('gemini_prompt_template', prompt);
  localStorage.setItem('gemini_selected_model', model);
  alert(`✨ Gemini API Key, 모델(${model}) 및 커스텀 프롬프트 템플릿이 브라우저에 안전하게 저장되었습니다!`);
}

function resetAiPromptTemplate() {
  if (!confirm('정말로 AI 프롬프트 템플릿을 기본 권장 템플릿으로 복원하시겠습니까?')) return;

  const promptInput = document.getElementById('geminiPromptTemplateInput');
  if (promptInput) promptInput.value = DEFAULT_GEMINI_PROMPT;
  localStorage.setItem('gemini_prompt_template', DEFAULT_GEMINI_PROMPT);
  alert('기본 AI 프롬프트 템플릿으로 복원되었습니다.');
}

async function generateAiDraftWithGemini() {
  const apiKey = (document.getElementById('geminiApiKeyInput')?.value || '').trim();
  const customTemplate = (document.getElementById('geminiPromptTemplateInput')?.value || '').trim() || DEFAULT_GEMINI_PROMPT;
  const extraNotes = (document.getElementById('aiSourceNotes')?.value || '').trim();
  const editorText = (document.getElementById('markdownEditor')?.value || '').trim();
  const statusEl = document.getElementById('aiDraftStatus');

  const modelSelect = document.getElementById('geminiModelSelect');
  let chosenModel = modelSelect ? modelSelect.value : 'gemini-3.5-flash';
  if (chosenModel === '__custom__') {
    chosenModel = (document.getElementById('geminiCustomModelInput')?.value || '').trim() || 'gemini-3.5-flash';
  }

  if (!apiKey) {
    alert('Gemini API Key를 입력해 주세요.');
    return;
  }

  // Combine active editor content + optional extra notes
  let combinedSource = '';
  if (editorText) {
    combinedSource = `[현재 에디터 본문 내용]:\n${editorText}`;
    if (extraNotes) {
      combinedSource += `\n\n[추가 요청사항 및 지시어]:\n${extraNotes}`;
    }
  } else if (extraNotes) {
    combinedSource = extraNotes;
  } else {
    alert('에디터에 본문 글이 없거나 참조할 노트가 없습니다. 에디터에 글을 작성하거나 추가 내용을 입력해 주세요.');
    return;
  }

  localStorage.setItem('gemini_api_key', apiKey);
  localStorage.setItem('gemini_prompt_template', customTemplate);
  localStorage.setItem('gemini_selected_model', chosenModel);
  statusEl.textContent = `🤖 ${chosenModel} 모델이 현재 본문을 바탕으로 글을 재구성 중입니다...`;

  const category = document.getElementById('postCategorySelect').value || 'PickSafe';
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Substitute template variables
  let finalPrompt = customTemplate
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{category\}\}/g, category)
    .replace(/\{\{notes\}\}/g, combinedSource);

  if (!customTemplate.includes('{{notes}}')) {
    finalPrompt += `\n\n[원본 개발 노트 및 요청사항]:\n${combinedSource}\n`;
  }

  const btn = document.getElementById('btnAiGenerate');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 작성 중...';
  }

  // Candidate fallback list: chosenModel first, then alternatives
  const candidateModels = [chosenModel, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
    .filter((m, idx, arr) => m && arr.indexOf(m) === idx);

  let success = false;
  let lastErrorMsg = '';

  try {
    for (const modelToTry of candidateModels) {
      statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <b>${modelToTry}</b> 모델로 글 작성 중... (약 3~5초 소요)`;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelToTry}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: finalPrompt }] }]
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.status === 200) {
          const data = await res.json();
          const parts = data.candidates?.[0]?.content?.parts || [];
          const draft = parts.map(p => p.text || '').join('').trim();

          if (draft) {
            document.getElementById('markdownEditor').value = draft;
            handleEditorChange();
            closeAiDraftModal();
            alert(`✨ [${modelToTry}] 모델 기반 AI 재구성이 성공적으로 완료되었습니다!`);
            success = true;
            break;
          } else {
            console.warn(`Model ${modelToTry} returned empty text parts.`);
          }
        } else {
          const err = await res.json().catch(() => ({}));
          lastErrorMsg = err.error?.message || res.statusText;
          console.warn(`Model ${modelToTry} failed (${res.status}):`, lastErrorMsg);
        }
      } catch (e) {
        lastErrorMsg = e.message;
        console.warn(`Model ${modelToTry} network error:`, e);
      }
    }

    if (!success) {
      alert(`AI 생성 실패: ${lastErrorMsg}\n\n모델 호출 중 오류가 발생했습니다. API Key와 네트워크 상태를 확인해 주세요.`);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
    statusEl.textContent = '';
  }
}

// ─── 10. Pixel-Perfect 100% Identical Naver Blog Live Preview ───
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

  // 1. Frontmatter Extraction
  let body = raw;
  let title = '';
  let category = '';
  let date = '';
  let tags = [];

  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n)?/;
  const fmMatch = raw.match(fmRegex);

  if (fmMatch) {
    body = raw.substring(fmMatch[0].length).trim();
    const fmContent = fmMatch[1];

    const titleMatch = fmContent.match(/title:\s*["']?(.*?)["']?\s*$/m);
    if (titleMatch) title = titleMatch[1].trim();

    const catMatch = fmContent.match(/categor(?:y|ies):\s*(?:\[\s*["']?(.*?)["']?\s*\]|["']?(.*?)["']?)\s*$/m);
    if (catMatch) category = (catMatch[1] || catMatch[2] || '').trim();

    const dateMatch = fmContent.match(/date:\s*["']?(.*?)["']?\s*$/m);
    if (dateMatch) date = dateMatch[1].trim();

    const tagMatch = fmContent.match(/tags:\s*\[(.*?)\]/m);
    if (tagMatch) {
      tags = tagMatch[1].split(',').map(t => t.replace(/["'\s]/g, '').trim()).filter(Boolean);
    }
  }

  if (!category) {
    category = document.getElementById('postCategorySelect')?.value || 'PickSafe';
  }

  // 2. Preprocess body: Convert dashes (---) directly under text into explicit divider <hr>
  body = body.replace(/([^\n\r])\r?\n(\s*[-*_]{3,}\s*)(\r?\n|$)/g, '$1\n\n$2\n\n');

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

    // 100% Identical Structure with single.html
    let breadcrumbHtml = '';
    let headerHtml = '';
    if (title) {
      breadcrumbHtml = `
        <div class="nb-breadcrumb">
          <a href="#"><i class="fa-solid fa-house"></i> 홈</a>
          <span class="nb-bc-sep">&gt;</span>
          <a href="#">카테고리</a>
          <span class="nb-bc-sep">&gt;</span>
          <a href="#">${escapeHtml(category)}</a>
          <span class="nb-bc-sep">&gt;</span>
          <span class="nb-bc-current">${escapeHtml(title.length > 30 ? title.substring(0, 30) + '...' : title)}</span>
        </div>
      `;

      headerHtml = `
        <header class="nb-article-header">
          <div class="nb-article-cat">
            <span class="nb-cat-tag">${escapeHtml(category)}</span>
          </div>
          <h1 class="nb-article-title">${escapeHtml(title)}</h1>
          <div class="nb-article-meta-row">
            <div class="nb-meta-left">
              <img src="/images/profile.jpg" alt="Daniel" class="nb-author-avatar-img" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=Daniel&background=03c75a&color=fff&size=64';">
              <div class="nb-meta-author-text">
                <span class="nb-author-name-bold">Daniel</span>
                <span class="nb-post-publish-date">${escapeHtml(date || new Date().toISOString().substring(0, 10))}</span>
              </div>
            </div>
            <div class="nb-meta-right">
              <button class="nb-util-btn" title="게시글 링크 복사"><i class="fa-solid fa-link"></i> URL 복사</button>
            </div>
          </div>
        </header>
      `;
    }

    let parsedBody = marked.parse(body);

    let tagsHtml = '';
    if (tags.length > 0) {
      tagsHtml = `
        <div class="nb-article-tags-wrap">
          <div class="nb-tag-label"><i class="fa-solid fa-tags"></i> 관련 태그</div>
          <div class="nb-article-tags">
            ${tags.map(t => `<span class="nb-post-tag">#${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
      `;
    }

    let footerHtml = `
      <div class="nb-article-footer">
        <div class="nb-like-action-box">
          <button class="nb-like-btn">
            <i class="fa-regular fa-heart"></i>
            <span>이 글이 유익했다면 공감하기</span>
            <span class="nb-like-count">0</span>
          </button>
        </div>
        <div class="nb-author-bottom-card">
          <img src="/images/profile.jpg" alt="Daniel" class="nb-bot-avatar" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=Daniel&background=03c75a&color=fff&size=96';">
          <div class="nb-bot-info">
            <h4>Daniel <span class="nb-bot-role">Backend & Systems Architect</span></h4>
            <p>초고속 응답 시스템 설계와 확장 가능한 데이터 파이프라인을 구축합니다. 기술적 의사결정의 이유와 Trade-off를 깊이 있게 기록합니다.</p>
            <div class="nb-bot-links">
              <a href="https://github.com/daniel-dataflow" target="_blank"><i class="fa-brands fa-github"></i> GitHub</a>
              <a href="mailto:daniel.han.developer@gmail.com"><i class="fa-regular fa-envelope"></i> Email</a>
            </div>
          </div>
        </div>
      </div>
    `;

    viewport.innerHTML = `
      <div class="nb-content-card nb-single-article">
        ${breadcrumbHtml}
        ${headerHtml}
        <div class="nb-article-body" id="nb-article-body">
          ${parsedBody}
        </div>
        ${tagsHtml}
        ${footerHtml}
      </div>
    `;

    // Resolve and Fallback Images for 100% Instant Preview
    const previewImgs = viewport.querySelectorAll('img');
    previewImgs.forEach(img => {
      const src = img.getAttribute('src') || '';
      if (window.blogImagePreviewCache && window.blogImagePreviewCache[src]) {
        img.src = window.blogImagePreviewCache[src];
      } else if (src.startsWith('/blog_images/') || src.startsWith('/static/blog_images/')) {
        const filename = src.split('/').pop();
        if (window.blogImagePreviewCache && window.blogImagePreviewCache[filename]) {
          img.src = window.blogImagePreviewCache[filename];
        } else {
          // If GitHub Pages is still building and /blog_images/ returns 404, fallback to GitHub Raw CDN!
          img.onerror = function() {
            if (!this.dataset.fallbackTried) {
              this.dataset.fallbackTried = 'true';
              this.src = `https://raw.githubusercontent.com/daniel-dataflow/daniel-dataflow.github.io/main/static/blog_images/${filename}`;
            }
          };
        }
      }
    });

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
