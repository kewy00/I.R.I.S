/**
 * Iris / Avatar Component (Node 7:18)
 * Renders the 4 official Figma states using the downloaded Figma SVGs
 * plus extended eye expressions (Feliz, Enfocada, Sorprendida, Dormida)
 * and 60fps eye-tracking / blinking.
 */

export const FIGMA_AVATAR_ASSETS = {
  Disponible: './src/assets/figma/iris-avatar-disponible.svg',
  Escuchando: './src/assets/figma/iris-avatar-escuchando.svg',
  Pensando: './src/assets/figma/iris-avatar-pensando.svg',
  Respondiendo: './src/assets/figma/iris-avatar-respondiendo.svg'
};

export const EXTRA_EYE_SVGS = {
  Feliz: `
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="32" fill="#F4F3F0"/>
      <path d="M17 34C18.5 28.5 27.5 28.5 29 34" stroke="#8A8783" stroke-width="5.5" stroke-linecap="round"/>
      <path d="M35 34C36.5 28.5 45.5 28.5 47 34" stroke="#8A8783" stroke-width="5.5" stroke-linecap="round"/>
    </svg>
  `,
  Enfocada: `
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="32" fill="#F4F3F0"/>
      <path d="M17 28L29 30.5V35.5C29 38 26.3 40 23 40C19.7 40 17 38 17 35.5V28Z" fill="#8A8783"/>
      <path d="M47 28L35 30.5V35.5C35 38 37.7 40 41 40C44.3 40 47 38 47 35.5V28Z" fill="#8A8783"/>
    </svg>
  `,
  Sorprendida: `
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="32" fill="#F4F3F0"/>
      <circle cx="22.5" cy="32" r="7.5" fill="#8A8783"/>
      <circle cx="41.5" cy="32" r="7.5" fill="#8A8783"/>
    </svg>
  `,
  Dormida: `
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="32" fill="#F4F3F0"/>
      <path d="M17 35C19 38.5 27 38.5 29 35" stroke="#8A8783" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M35 35C37 38.5 45 38.5 47 35" stroke="#8A8783" stroke-width="4.5" stroke-linecap="round"/>
    </svg>
  `
};

export function renderIrisAvatarHTML(state = 'Disponible', idSuffix = 'main') {
  const figmaAsset = FIGMA_AVATAR_ASSETS[state];
  if (figmaAsset) {
    return `
      <div class="iris-avatar-svg-wrap" data-state="${state}" id="iris-avatar-${idSuffix}">
        <img alt="Iris (${state})" class="iris-avatar-img" width="64" height="64" src="${figmaAsset}" />
      </div>
    `;
  }

  const customSvg = EXTRA_EYE_SVGS[state] || EXTRA_EYE_SVGS.Feliz;
  return `
    <div class="iris-avatar-svg-wrap" data-state="${state}" id="iris-avatar-${idSuffix}">
      ${customSvg}
    </div>
  `;
}

export function renderSpotifyDiscHTML(albumArtUrl = '', trackName = '', idSuffix = 'live') {
  const safeTitle = String(trackName || 'Spotify').replace(/"/g, '&quot;');
  const safeUrl = String(albumArtUrl || '').replace(/"/g, '&quot;');
  const imgHtml = safeUrl
    ? `<img alt="${safeTitle}" class="iris-spotify-disc-img" width="64" height="64" src="${safeUrl}" />`
    : `<div class="iris-spotify-disc-fallback"></div>`;
  return `
    <div class="iris-avatar-svg-wrap iris-spotify-disc-wrap" data-state="SpotifyPlaying" id="iris-avatar-${idSuffix}">
      <div class="iris-spotify-disc">
        ${imgHtml}
        <span class="iris-spotify-disc-grooves"></span>
        <span class="iris-spotify-disc-center"></span>
      </div>
    </div>
  `;
}

/**
 * Attaches smooth mouse eye-tracking and natural blinking to an avatar container
 */
export function attachIrisEyePhysics(avatarElement) {
  if (!avatarElement) return;

  let currentX = 0;
  let currentY = 0;
  let targetX = 0;
  let targetY = 0;

  window.addEventListener('mousemove', (e) => {
    const rect = avatarElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const dist = Math.hypot(dx, dy) || 1;
    const maxOffset = 3.2;
    const factor = Math.min(dist / 180, 1);

    targetX = (dx / dist) * maxOffset * factor;
    targetY = (dy / dist) * maxOffset * factor;
  });

  function animateEyes() {
    currentX += (targetX - currentX) * 0.18;
    currentY += (targetY - currentY) * 0.18;
    const wrap = avatarElement.querySelector('.iris-avatar-svg-wrap');
    if (wrap) {
      if (wrap.classList.contains('iris-spotify-disc-wrap')) {
        wrap.style.transform = 'translate3d(0px, 0px, 0)';
      } else {
        wrap.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0)`;
      }
    }
    requestAnimationFrame(animateEyes);
  }
  requestAnimationFrame(animateEyes);
}
