/**
 * Naver Blog Theme JavaScript - Daniel Tech Blog
 * Interactive features: Full-Site Live Search, URL Copy, Like Button, TOC Toggle, Code Copy, Back to Top
 */

let searchIndex = null;

document.addEventListener('DOMContentLoaded', () => {
  initResponsiveTables();
  initLiveSearch();
  initCodeCopyButtons();
  initBackToTop();
  checkLikeState();
});

// 0. Auto-Wrap Tables for Smooth Horizontal Scrolling on Mobile
function initResponsiveTables() {
  const tables = document.querySelectorAll('.nb-article-body table');
  tables.forEach(table => {
    if (table.parentElement && table.parentElement.classList.contains('nb-table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'nb-table-wrap';
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

// 1. Toast Notification
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
  }, 2400);
}

// 2. URL Copy
function copyPostUrl() {
  const url = window.location.href;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('🔗 게시글 URL이 클립보드에 복사되었습니다.');
    }).catch(() => {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    showToast('🔗 게시글 URL이 클립보드에 복사되었습니다.');
  } catch (err) {
    showToast('URL 복사에 실패했습니다.');
  }
  document.body.removeChild(textArea);
}

// 3. Like (공감 ❤️) Toggle
function togglePostLike() {
  const likeBtn = document.getElementById('nb-article-like-btn');
  const countEl = document.getElementById('nb-post-like-count');
  const iconEl = document.getElementById('nb-like-icon');
  if (!likeBtn) return;

  const postId = window.location.pathname;
  const storageKey = `nb_like_${postId}`;
  let isLiked = localStorage.getItem(storageKey) === 'true';

  isLiked = !isLiked;
  localStorage.setItem(storageKey, isLiked ? 'true' : 'false');

  if (isLiked) {
    likeBtn.classList.add('liked');
    if (iconEl) iconEl.className = 'fa-solid fa-heart';
    if (countEl) countEl.textContent = '1';
    showToast('❤️ 포스트에 공감했습니다!');
  } else {
    likeBtn.classList.remove('liked');
    if (iconEl) iconEl.className = 'fa-regular fa-heart';
    if (countEl) countEl.textContent = '0';
    showToast('공감을 취소했습니다.');
  }
}

function checkLikeState() {
  const likeBtn = document.getElementById('nb-article-like-btn');
  const countEl = document.getElementById('nb-post-like-count');
  const iconEl = document.getElementById('nb-like-icon');
  if (!likeBtn) return;

  const postId = window.location.pathname;
  const storageKey = `nb_like_${postId}`;
  const isLiked = localStorage.getItem(storageKey) === 'true';

  if (isLiked) {
    likeBtn.classList.add('liked');
    if (iconEl) iconEl.className = 'fa-solid fa-heart';
    if (countEl) countEl.textContent = '1';
  } else {
    if (countEl) countEl.textContent = '0';
  }
}

// 4. TOC Toggle
function toggleToc() {
  const content = document.getElementById('nb-toc-content');
  const arrow = document.getElementById('nb-toc-arrow');
  if (!content) return;

  const isHidden = content.style.display === 'none';
  content.style.display = isHidden ? 'block' : 'none';
  if (arrow) {
    arrow.className = isHidden ? 'fa-solid fa-chevron-down nb-toc-arrow' : 'fa-solid fa-chevron-right nb-toc-arrow';
  }
}

// 5. Code Block Copy Button
function initCodeCopyButtons() {
  const codeBlocks = document.querySelectorAll('.nb-article-body pre');
  codeBlocks.forEach(pre => {
    if (pre.querySelector('.nb-copy-code-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nb-copy-code-btn';
    btn.innerHTML = '<i class="fa-regular fa-copy"></i> 복사';
    pre.style.position = 'relative';
    pre.appendChild(btn);

    btn.addEventListener('click', () => {
      const code = pre.querySelector('code') || pre;
      const textToCopy = code.innerText.replace(/복사$/, '').trim();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast('📋 코드가 클립보드에 복사되었습니다.');
        });
      }
    });
  });
}

// 6. Full-Site Live Search with Dropdown (Desktop & Mobile)
async function initLiveSearch() {
  const inputs = [
    { input: document.getElementById('nb-search-input'), results: document.getElementById('nb-search-results') },
    { input: document.getElementById('nb-m-search-input'), results: document.getElementById('nb-m-search-results') }
  ];

  try {
    const res = await fetch('/index.json');
    if (res.ok) {
      searchIndex = await res.json();
    }
  } catch (e) {
    console.warn('Search index load error:', e);
  }

  inputs.forEach(({ input, results }) => {
    if (!input || !results) return;

    input.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        results.style.display = 'none';
        results.innerHTML = '';
        return;
      }

      if (!searchIndex) {
        results.innerHTML = '<div class="nb-search-empty">검색 인덱스를 불러오는 중입니다...</div>';
        results.style.display = 'block';
        return;
      }

      const matches = searchIndex.filter(post => {
        const t = (post.title || '').toLowerCase();
        const c = (post.category || '').toLowerCase();
        const s = (post.summary || '').toLowerCase();
        const tags = (post.tags || []).join(' ').toLowerCase();
        return t.includes(query) || c.includes(query) || s.includes(query) || tags.includes(query);
      });

      if (matches.length === 0) {
        results.innerHTML = `<div class="nb-search-empty">🔍 <b>"${escapeHtml(query)}"</b>에 대한 검색 결과가 없습니다.</div>`;
      } else {
        results.innerHTML = `
          <div class="nb-search-header">검색 결과 (${matches.length}건)</div>
          <div class="nb-search-items">
            ${matches.slice(0, 8).map(item => `
              <a href="${item.permalink}" class="nb-search-item">
                <div class="nb-search-item-cat">${escapeHtml(item.category)}</div>
                <div class="nb-search-item-title">${escapeHtml(item.title)}</div>
                <div class="nb-search-item-summary">${escapeHtml(item.summary)}</div>
                <div class="nb-search-item-date">${escapeHtml(item.date)}</div>
              </a>
            `).join('')}
          </div>
        `;
      }
      results.style.display = 'block';
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.style.display = 'none';
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        results.style.display = 'none';
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 7. Back to Top
function initBackToTop() {
  const topBtn = document.getElementById('nb-back-to-top');
  if (!topBtn) return;

  topBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}
