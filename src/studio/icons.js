/*
 * Globe HUD icons. Font Awesome Solid, imported per-file so bun
 * does not pull the 1 MB icon barrel.
 */
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons/faChevronLeft';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons/faChevronRight';
import { faCompass } from '@fortawesome/free-solid-svg-icons/faCompass';
import { faHouse } from '@fortawesome/free-solid-svg-icons/faHouse';
import { faRuler } from '@fortawesome/free-solid-svg-icons/faRuler';

const ICONS = {
    'chevron-left': faChevronLeft,
    'chevron-right': faChevronRight,
    compass: faCompass,
    house: faHouse,
    ruler: faRuler,
};

function svgFor(def, className) {
    const [width, height, , , path] = def.icon;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const d = Array.isArray(path) ? path.join(' ') : path;
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    node.setAttribute('fill', 'currentColor');
    node.setAttribute('d', d);
    svg.appendChild(node);
    return svg;
}

function mountHudIcons() {
    if (typeof document === 'undefined') return;
    for (const el of document.querySelectorAll('[data-icon]')) {
        const def = ICONS[el.dataset.icon];
        if (!def) continue;
        el.replaceWith(svgFor(def, el.getAttribute('class') || ''));
    }
}

export { mountHudIcons };
