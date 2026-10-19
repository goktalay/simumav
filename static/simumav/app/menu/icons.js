// Menü kartı ikonları: animasyonlu inline SVG (CSS ile mikro-animasyon; fx.css). Parça sınıfları: .door (hangar kapısı açılır),
// .eye/.lid (pilot göz kırpar), .flag (bayrak dalgalanır), .route (rota çizilir), .plane (uçak kalkar), .hand (saat ilerler).
import { svg } from '../core/dom.js';

const S = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  hangar: `<g ${S}><path d="M8 56V30L32 12l24 18v26"/><path d="M6 56h52"/><path class="door-frame" d="M18 56V36h28v20"/>
    <rect class="door door-l" x="19" y="37" width="13" height="18" fill="currentColor" fill-opacity=".18"/><rect class="door door-r" x="32" y="37" width="13" height="18" fill="currentColor" fill-opacity=".18"/>
    <g class="drone-in"><path d="M26 47h12"/><circle cx="25" cy="47" r="2.4"/><circle cx="39" cy="47" r="2.4"/></g></g>`,
  crew: `<g ${S}><circle cx="32" cy="24" r="11"/><path d="M12 56c2-11 10-17 20-17s18 6 20 17"/>
    <g class="eye"><circle cx="27.5" cy="23" r="1.6" fill="currentColor"/><circle cx="36.5" cy="23" r="1.6" fill="currentColor"/></g>
    <path class="lid" d="M24 23h7M33 23h7" opacity="0"/><path class="smile" d="M27 29c2.5 2.5 7.5 2.5 10 0"/><path class="visor" d="M20 19h24" stroke-opacity=".6"/></g>`,
  tracks: `<g ${S}><path d="M14 58V12"/><path class="flag" d="M14 14c8-5 14 5 22 0s10-4 14-2v18c-4-2-8-2-14 2s-14-5-22 0"/>
    <path class="wind w1" d="M44 44h12" stroke-opacity=".7"/><path class="wind w2" d="M40 50h16" stroke-opacity=".5"/><path class="wind w3" d="M46 56h8" stroke-opacity=".35"/></g>`,
  missions: `<g ${S}><path class="route" d="M10 50c8-18 16-6 24-16s10-14 20-20" stroke-dasharray="70" stroke-dashoffset="0"/>
    <circle class="wp wp1" cx="10" cy="50" r="3.2" fill="currentColor"/><circle class="wp wp2" cx="34" cy="34" r="3.2" fill="currentColor"/><circle class="wp wp3" cx="54" cy="14" r="3.2" fill="currentColor"/>
    <path d="M10 58h44" stroke-opacity=".4"/></g>`,
  fly: `<g ${S}><g class="plane"><path d="M8 40l26-6 18-22 4 4-14 24-6 18-6-10-12-2z"/><path d="M34 34l-14 2"/><path d="M28 50l6-16"/></g>
    <path class="runway" d="M6 56h52" stroke-dasharray="6 6"/><path class="puff p1" d="M12 46h3" stroke-opacity=".5"/><path class="puff p2" d="M8 50h4" stroke-opacity=".35"/></g>`,
  ops: `<g ${S}><circle cx="32" cy="32" r="22"/><path d="M32 14v3M50 32h-3M32 50v-3M14 32h3" stroke-opacity=".6"/>
    <path class="hand" d="M32 32V19"/><path class="hand2" d="M32 32l9 5" stroke-opacity=".8"/><circle cx="32" cy="32" r="2" fill="currentColor"/>
    <path class="radar" d="M32 32L46 20" stroke-opacity=".5"/></g>`,
};

export const icon = key => svg('0 0 64 64', ICONS[key] || '', `mico mico-${key}`);
