/**
 * Naver Blog Theme JavaScript - Daniel Tech Blog
 * Interactive features: URL Copy, Like Button, TOC Toggle, Code Copy, Live Search, Back to Top
 */

document.addEventListener('DOMContentLoaded', () => {
  initCodeCopyButtons();
  initLiveSearch();
  initBackToTop();
  checkLikeState();
});

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
    if (countEl) countEl.textContent = '2';
    showToast('❤️ 포스트에 공감했습니다!');
  } else {
    likeBtn.classList.remove('liked');
    if (iconEl) iconEl.className = 'fa-regular fa-heart';
    if (countEl) countEl.textContent = '1';
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
    if (countEl) countEl.textContent = '2';
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

// 6. Live Search in Sidebar
function initLiveSearch() {
  const searchInput = document.getElementById('nb-search-input');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const postItems = document.querySelectorAll('.nb-post-item, .nb-recent-item');
    if (!postItems.length) return;

    postItems.forEach(item => {
      const text = item.innerText.toLowerCase();
      item.style.display = (!query || text.includes(query)) ? 'block' : 'none';
    });
  });
}

// 7. Back to Top
function initBackToTop() {
  const topBtn = document.getElementById('nb-back-to-top');
  if (!topBtn) return;

  topBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}
