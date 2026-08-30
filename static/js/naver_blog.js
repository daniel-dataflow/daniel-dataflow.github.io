/**
 * Naver Blog Theme JavaScript - Daniel Tech Log
 * Interactive features: Likes, TOC, Code Copy, URL Copy, Search Filter, Font Sizer
 */

document.addEventListener('DOMContentLoaded', () => {
  initToast();
  initLikeButton();
  initUrlCopy();
  initFontSizer();
  initTocToggle();
  initOtherPostsToggle();
  initViewModeToggle();
  initCodeCopyButtons();
  initLiveSearch();
  initBackToTop();
});

// 1. Toast Notification
function showToast(message) {
  const toast = document.getElementById('nb-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2600);
}
function initToast() {}

// 2. Like (공감 ❤️) Button with LocalStorage
function initLikeButton() {
  const likeBtn = document.getElementById('nb-like-button');
  if (!likeBtn) return;

  const postId = likeBtn.getAttribute('data-post-id') || window.location.pathname;
  const countEl = document.getElementById('nb-like-count');
  const storageKey = `nb_like_${postId}`;

  let isLiked = localStorage.getItem(storageKey) === 'true';
  let baseCount = 1;

  if (isLiked) {
    likeBtn.classList.add('liked');
    if (countEl) countEl.textContent = baseCount + 1;
  }

  likeBtn.addEventListener('click', () => {
    isLiked = !isLiked;
    localStorage.setItem(storageKey, isLiked ? 'true' : 'false');

    if (isLiked) {
      likeBtn.classList.add('liked');
      if (countEl) countEl.textContent = baseCount + 1;
      showToast('❤️ 포스트에 공감했습니다!');
    } else {
      likeBtn.classList.remove('liked');
      if (countEl) countEl.textContent = baseCount;
      showToast('공감을 취소했습니다.');
    }
  });

  const shareBtn = document.getElementById('nb-share-button');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      copyToClipboard(window.location.href, '🔗 링크가 클립보드에 복사되었습니다.');
    });
  }
}

// 3. URL Copy
function initUrlCopy() {
  const copyBtn = document.getElementById('nb-copy-url');
  if (!copyBtn) return;

  copyBtn.addEventListener('click', () => {
    copyToClipboard(window.location.href, '🔗 게시글 URL이 복사되었습니다.');
  });
}

function copyToClipboard(text, successMsg) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg);
    }).catch(() => {
      fallbackCopy(text, successMsg);
    });
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    showToast(successMsg);
  } catch (err) {
    showToast('URL 복사에 실패했습니다.');
  }
  document.body.removeChild(textArea);
}

// 4. Font Size Zoom (가- / 가+)
function initFontSizer() {
  const decBtn = document.getElementById('nb-font-dec');
  const incBtn = document.getElementById('nb-font-inc');
  const article = document.getElementById('nb-article-content');
  if (!decBtn || !incBtn || !article) return;

  let currentScale = parseFloat(localStorage.getItem('nb_font_scale') || '1.0');
  applyFontSize(currentScale);

  decBtn.addEventListener('click', () => {
    if (currentScale > 0.85) {
      currentScale -= 0.08;
      applyFontSize(currentScale);
    }
  });

  incBtn.addEventListener('click', () => {
    if (currentScale < 1.35) {
      currentScale += 0.08;
      applyFontSize(currentScale);
    }
  });

  function applyFontSize(scale) {
    article.style.fontSize = `${(1.06 * scale).toFixed(2)}rem`;
    localStorage.setItem('nb_font_scale', scale.toString());
  }
}

// 5. TOC Toggle
function initTocToggle() {
  const tocHeader = document.getElementById('nb-toc-toggle');
  const tocBox = document.querySelector('.nb-toc-box');
  const tocContent = document.getElementById('nb-toc-content');
  if (!tocHeader || !tocBox || !tocContent) return;

  tocHeader.addEventListener('click', () => {
    const isCollapsed = tocBox.classList.toggle('collapsed');
    tocContent.style.display = isCollapsed ? 'none' : 'block';
  });
}

// 6. Other Posts Toggle
function initOtherPostsToggle() {
  const toggleBtn = document.getElementById('nb-other-toggle');
  const body = document.getElementById('nb-other-posts-body');
  if (!toggleBtn || !body) return;

  let isOpen = true;
  toggleBtn.addEventListener('click', () => {
    isOpen = !isOpen;
    body.style.display = isOpen ? 'block' : 'none';
    toggleBtn.querySelector('span').textContent = isOpen ? '접기' : '펼치기';
    const icon = toggleBtn.querySelector('i');
    if (icon) {
      icon.className = isOpen ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    }
  });
}

// 7. View Mode Switcher (Card / List)
function initViewModeToggle() {
  const toggleBtns = document.querySelectorAll('.nb-v-btn');
  const postsList = document.getElementById('nb-posts-list');
  if (!toggleBtns.length || !postsList) return;

  const savedMode = localStorage.getItem('nb_view_mode') || 'card';
  setViewMode(savedMode);

  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-view');
      setViewMode(mode);
    });
  });

  function setViewMode(mode) {
    toggleBtns.forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-view') === mode);
    });
    postsList.classList.remove('view-card', 'view-list');
    postsList.classList.add(`view-${mode}`);
    localStorage.setItem('nb_view_mode', mode);
  }
}

// 8. Code Block Copy Button
function initCodeCopyButtons() {
  const codeBlocks = document.querySelectorAll('.nb-article-body pre');
  codeBlocks.forEach(pre => {
    const btn = document.createElement('button');
    btn.className = 'nb-copy-code-btn';
    btn.innerHTML = '<i class="fa-regular fa-copy"></i> 복사';
    pre.appendChild(btn);

    btn.addEventListener('click', () => {
      const code = pre.querySelector('code') || pre;
      const textToCopy = code.innerText.replace(/복사$/, '').trim();
      copyToClipboard(textToCopy, '📋 코드가 클립보드에 복사되었습니다.');
    });
  });
}

// 9. Live Search in Sidebar
function initLiveSearch() {
  const searchInput = document.getElementById('nb-search-input');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const postItems = document.querySelectorAll('.nb-post-item');
    if (!postItems.length) return;

    postItems.forEach(item => {
      const title = (item.getAttribute('data-title') || '').toLowerCase();
      const tags = (item.getAttribute('data-tags') || '').toLowerCase();
      const text = item.innerText.toLowerCase();

      if (!query || title.includes(query) || tags.includes(query) || text.includes(query)) {
        item.style.display = 'block';
      } else {
        item.style.display = 'none';
      }
    });
  });
}

// 10. Back to Top
function initBackToTop() {
  const topBtn = document.getElementById('nb-back-to-top');
  if (!topBtn) return;

  topBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}
