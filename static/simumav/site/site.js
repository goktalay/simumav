// SIMUMAV tanıtım — yer tutucu (ön yüz ajanı ezer). Oturum varsa doğrudan oyuna.
import { session } from '/sim/api.js';
session.me().then(() => { if (!new URLSearchParams(location.search).has('giris')) location.replace('/app/'); }).catch(() => {});
