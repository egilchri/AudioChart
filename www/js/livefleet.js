// The live AIS vessels, what each one is and how she's drawn (v1009: from bay3d.js, so the helm view draws them the
// same way, requested: "add live AIS to the helm view"). bay3d.js and helm3d.js both use identify() and liveModel().
import * as THREE from 'three';
import { makeSailboat } from './sailboat3d.js';
import { makeTrimmer } from './weather3d.js';
import { cruiseShipModel, ferryModelSimple, launchModel, cblModel, merchantModel } from './vessels.js';
import { harborKind } from './harborferries3d.js';
import { tankerModel, tugModel, pilotModel, containerModel, bulkModel, carCarrierModel, lpgModel, trawlerModel, researchModel, dredgerModel, cutterModel, scallopModel, cableModel, osvModel, shipFor } from './ships3d.js';
import { aisClass, knownFor } from './ais.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// the ferries' and the windjammers' full names, for knownFor (ais.js setKnown): fd ferries.json, wd windjammers.json
// (a ferry run to a timetable has several boats, each her own name and length: F.boats, v993; Independence is only
// the Chebeague ferry heard near her run: the name is a common one, v998)
export function knownList(fd, wd) {
  const boatsOf = F => F.boats ? F.boats.map((b, bi) => ({ ...F, ...b, bi })) : [F];
  const nearLine = F => { const xs = F.line.map(p => p[0]), ys = F.line.map(p => p[1]); return [Math.min(...xs) - 0.03, Math.min(...ys) - 0.02, Math.max(...xs) + 0.03, Math.max(...ys) + 0.02]; };
  return [...(fd?.ferries || []).flatMap(boatsOf).map(F => ({ name: F.vessel, F, box: F.kind === 'ctc' ? nearLine(F) : null })), ...(wd?.windjammers || []).map(W => ({ name: W.name, W }))];
}

export const LIVE_LEN = { sail: 11, power: 11, launch: 18, ferry: 46, cruise: 200, ship: 150, tanker: 150, tug: 28, pilot: 16, cargo: 140, trawler: 26, research: 45, dredger: 50, cutter: 30, scalloper: 26, cable: 120, osv: 80 };
// a cargo ship (AIS type 70–79) is a container ship or a bulk carrier, which AIS doesn't say (v1002): her record's
// kind, else her operator's (Eimskip's are container ships), else where she's bound (Searsport and Bucksport take
// bulk), else her shape (a bulker is the beamier, for her length), else a container ship, Portland's usual caller
function cargoKind(A, S, liv) {
  if (S?.kind === 'container' || S?.kind === 'bulk' || S?.kind === 'pcc') return S.kind;
  if (liv?.kinds?.length) return ['bulk', 'pcc'].includes(liv.kinds[0]) ? liv.kinds[0] : 'container';
  // a car carrier, by the names the big lines give theirs (K Line's "… Highway", MOL's "… Ace", NYK's "… Leader",
  // Eukor's "Morning …", Höegh's, Glovis's), v1003
  if (/HIGHWAY|\bACE$|\bLEADER$|^MORNING |^HOEGH |GLOVIS|AUTO(LINER|STAR|BANNER|SKY|PRIDE)/i.test(A.name || '')) return 'pcc';
  if (/SEARS|BUCKSP|MACK ?P/i.test(A.dest || '')) return 'bulk';
  if (A.L && A.B && A.B / A.L > 0.158) return 'bulk';
  return 'container';
}
// a tanker (AIS 80–89) carrying gas is an LPG carrier: her record or operator says so, or her name does (v1003)
function tankerKind(A, S, liv) {
  if (S?.kind === 'lpg' || liv?.kinds?.[0] === 'lpg') return 'lpg';
  return /\b(GAS|LPG|LNG|PROPANE|BUTANE|ETHYLENE)\b|GAS$/i.test(A.name || '') ? 'lpg' : 'tanker';
}
// a research vessel, which AIS has no type for (v1004): her record says so, or her name (R/V …, NOAA ships)
const RESEARCH = /^(R\/?V|RV|NOAAS?)\b|\bRESEARCH\b|^HENRY B\.? ?BIGELOW|^GORDON GUNTER|^PISCES$|^ENDEAVOR$/i;
// a sea scalloper (v1006), which AIS calls a fishing vessel like any other: her record says so, or she's bound for
// a scallop port, or she's as beamy as a scalloper is for her length and short of a big trawler's (a guess)
const scalloper = (A, S) => S?.kind === 'scalloper' || /NEW ?BEDFORD|FAIRHAVEN|CAPE ?MAY/i.test(A.dest || '') || !!(A.L && A.B && A.L < 35 && A.B / A.L >= 0.32);
// a cable ship by her name (v1006): CS …, "CABLE", and the fleets' own names (SubCom's, Global Marine's, Orange Marine's)
const CABLE = /^C\.?S\.? |\bCABLE\b|^(GLOBAL (SENTINEL|SYMPHONY|MARINER|CITIZEN|ODYSSEY|SURVEYOR)|ILE DE (BREHAT|SEIN|BATZ|RE)|LEON THEVENIN|RAYMOND CROZE|PIERRE DE FERMAT|SOPHIE GERMAIN|DECISIVE|RELIANCE|RESOLUTE|DEPENDABLE|DURABLE|RESPONDER)$/i;
// an offshore supply vessel by her name (v1007), whatever type her AIS gives (most send 90, "other", or a tug's):
// the fleets' prefixes (Hornbeck's HOS, Harvey Gulf's, Seacor's, Bourbon's, Siem's, Solstad's Normand, Havila's,
// DOF's Skandi), or SUPPLY, SUPPLIER, OFFSHORE, ANCHOR HANDLER in her name
const OSV = /^(HOS|HARVEY|SEACOR|BOURBON|SIEM|NORMAND|HAVILA|SKANDI)\b|\b(SUPPL(Y|IER)|OFFSHORE|ANCHOR HANDLER|AHTS|PSV)\b/i;
// a Coast Guard cutter by her name (v1005), whatever type her AIS gives
const CUTTER = /^(USCGC|USCG|CGC)\b|\bCOAST ?GUARD\b|^(ABBIE BURGESS|MARCUS HANNA|IDA LEWIS|KATHERINE WALKER|JAMES RANKIN|JOSHUA APPLEBY|(THUNDER|MORRO|STURGEON|KATMAI|BRISTOL|MOBILE|BISCAYNE|NEAH|PENOBSCOT) BAY)$/i;   // (and the cutters by their own names: the keeper-class buoy tenders, the icebreaking tugs)
// (v1177) what a tug's doing with a barge, from her AIS status: 'push' (12, pushing ahead or alongside), 'tow' (11, towing
// astern), or ''
export const towOf = A => A.status === 12 ? 'push' : A.status === 11 ? 'tow' : '';
// her barge: a raked box hull, black, a rust-red deck, and one of three loads (by her MMSI): a hopper of stone, a tank
// barge's pipes and pump house, a deck barge's containers. Pushed: ahead of her, her bow in its notch. Towed: 90 m
// astern on her hawser.
function addBarge(g, tow, Lt, Lb, B, seed) {
  const b = new THREE.Group(), M = c => new THREE.MeshLambertMaterial({ color: c });
  const FB = 2.2, DR = 2.4, rake = Math.min(6, Lb * 0.1);
  const sh = new THREE.Shape([new THREE.Vector2(-Lb / 2, FB), new THREE.Vector2(Lb / 2, FB), new THREE.Vector2(Lb / 2 - rake, -DR), new THREE.Vector2(-Lb / 2 + rake, -DR)]);
  const hg = new THREE.ExtrudeGeometry(sh, { depth: B, bevelEnabled: false }); hg.rotateY(Math.PI / 2); hg.translate(-B / 2, 0, 0);
  b.add(new THREE.Mesh(hg, [M(0x2a2624), M(0x2a2624)]));
  const deck = new THREE.Mesh(new THREE.BoxGeometry(B - 0.6, 0.12, Lb - 0.6), M(0x6e3c28)); deck.position.y = FB + 0.06; b.add(deck);
  const box = (w, h, d, x, y, z, c) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c)); k.position.set(x, y, z); b.add(k); return k; };
  const load = seed % 3;
  if (load === 0) {   // a hopper: coamings and a pile of stone in it
    for (const sx of [-1, 1]) box(0.5, 1.6, Lb - 8, sx * (B / 2 - 1.2), FB + 0.8, 0, 0x3a3532);
    for (const sz of [-1, 1]) box(B - 2, 1.6, 0.5, 0, FB + 0.8, sz * (Lb / 2 - 4), 0x3a3532);
    const pile = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 12), M(0x8a8478)); pile.scale.set(B * 0.42, 3.4, (Lb - 10) * 0.45); pile.position.y = FB + 1.7; b.add(pile);
  } else if (load === 1) {   // a tank barge: low, its pipe run and manifold, a pump house aft
    box(0.5, 0.5, Lb - 6, 0, FB + 0.35, 0, 0x9a9da0); for (const z of [-Lb * 0.2, 0, Lb * 0.2]) box(B * 0.7, 0.4, 0.4, 0, FB + 0.3, z, 0x9a9da0);
    box(B * 0.5, 2.4, 4, 0, FB + 1.2, Lb / 2 - 5, 0xd8d4cc); for (const z of [-Lb * 0.3, Lb * 0.3]) box(0.8, 1.8, 0.8, 0, FB + 0.9, z, 0xc9302a);
  } else {   // a deck barge: rows of containers
    const cols = [0x1d5f8a, 0xa8322a, 0x2f7a3a, 0xd9a52b, 0x7a7d80, 0x5a3a7a];
    for (let i = 0; i < Math.floor((Lb - 10) / 12.5); i++) for (let j = 0; j < Math.floor((B - 2) / 2.5); j++) if ((i * 7 + j * 3 + seed) % 5) box(2.4, 2.6, 12.1, -B / 2 + 1.5 + j * 2.5, FB + 1.3, -Lb / 2 + 6 + i * 12.5 + 6, cols[(i * 3 + j + seed) % cols.length]);
  }
  if (tow === 'push') b.position.z = -Lt / 2 - Lb / 2 + 2.5;   // (her bow to -z; in the barge's notch)
  else {
    const gap = 90; b.position.z = Lt / 2 + gap + Lb / 2;
    const hawser = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, gap), M(0x1a1a1a)); hawser.position.set(0, 0.8, Lt / 2 + gap / 2); hawser.rotation.x = 0.012; g.add(hawser);
  }
  // her running lights at the bow end (v1178): red to port, green to starboard (her bow to -z, so starboard's +x)
  for (const [sx, c] of [[-1, 0xff2a1a], [1, 0x2aff6a]]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: c })); l.position.set(sx * (B / 2 - 0.4), FB + 1.1, -Lb / 2 + rake + 0.6); b.add(l);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 8), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending })); halo.position.copy(l.position); b.add(halo);   // (its glow, to be seen 100 m off at night)
  }
  b.userData.barge = true; g.add(b);
}
export function liveModel(A, cls, seed, K, W, lit) {
  // one of the ferries we know (K, her ferries.json record): built from it, so she's the scheduled one to the life (v987)
  if (K) return { group: (K.kind === 'launch' ? launchModel : (K.kind === 'cbl' || K.kind === 'ctc') ? cblModel : ferryModelSimple)(K, lit), L: K.length_m || (K.kind === 'launch' ? 14 : 46) };
  // one of the windjammers (W, her windjammers.json record, v990): Angelique and Bowdoin as themselves, the
  // others as the fleet's schooner brought to her length on deck
  if (W) {
    const boat = makeSailboat(W.model || 'schooner', seed);
    if (!W.model && W.lod_ft) { const k = W.lod_ft * 0.3048 / boat.L; for (const c of boat.group.children) c.scale.multiplyScalar(k); boat.L *= k; }
    return { boat, group: boat.group, L: boat.L, trim: makeTrimmer() };
  }
  // one of New York Harbor's passenger boats as herself, not a Maine car ferry (v1063; harborferries3d.js)
  if (cls.harbor) return { group: cls.harbor.build(lit), L: cls.harbor.L };
  const L = A.L || LIVE_LEN[cls.model];
  if (cls.model === 'sail' || cls.model === 'power') {
    // a big sailing yacht, 45 to 72 ft, as one, drawn to her own length (v1025)
    const yacht = cls.model === 'sail' && L >= 13.5 && L <= 22;
    const boat = yacht ? makeSailboat('yacht', seed, L) : makeSailboat(cls.model === 'power' ? 'lobster' : L > 20 ? 'schooner' : L > 9.5 ? 'cruiser' : L > 7 ? 'pocket' : 'daysailer', seed);
    return { boat, group: boat.group, L: boat.L, trim: cls.model === 'sail' ? makeTrimmer() : null };
  }
  // a tanker, tug or pilot boat as her kind, in her owner's colours, her particulars where we have them (v1001)
  if (['tanker', 'tug', 'pilot', 'cargo', 'trawler', 'research', 'dredger', 'cutter', 'scalloper', 'cable', 'osv'].includes(cls.model)) {
    const { S, liv } = shipFor(A.mmsi, A.name), V = { L, B: A.B || S?.B, D: S?.D, T: A.draught, name: S?.name || A.name, boat: S?.boat };
    const kind = cls.model === 'cargo' ? cargoKind(A, S, liv) : cls.model === 'tanker' ? tankerKind(A, S, liv) : cls.model;
    // (v1177) a tug pushing ahead (AIS status 12) or towing astern (11): her barge with her. Many give the length of the
    // two together (the Buchanan 12, "182 m"; an ATB's 147): over 45 m a tug's taken as 32 m, the rest her barge
    const tow = towOf(A);
    if (cls.model === 'tug' && (tow || L > 45)) {
      const Lt = L > 45 ? 32 : L, Lb = L > 45 ? Math.max(30, L - Lt) : 60 + (seed % 4) * 10, Bb = L > 45 && A.B ? Math.max(10, A.B) : 15 + (seed % 3) * 2;
      const g = tugModel({ ...V, L: Lt, B: L > 45 ? Math.min(A.B || 11, 12) : V.B }, liv, lit);
      if (tow) addBarge(g, tow, Lt, Lb, Bb, seed);
      return { group: g, L: Lt, tow };
    }
    return { group: { tanker: tankerModel, lpg: lpgModel, tug: tugModel, pilot: pilotModel, container: containerModel, bulk: bulkModel, pcc: carCarrierModel, trawler: trawlerModel, research: researchModel, dredger: dredgerModel, cutter: cutterModel, scalloper: scallopModel, cable: cableModel, osv: osvModel }[kind](V, liv, lit), L };
  }
  const group = cls.model === 'launch' ? launchModel({ length_m: clamp(L, 9, 40), name: A.name }, lit)
    : cls.model === 'ferry' ? ferryModelSimple({ length_m: L, name: A.name }, lit)
    : cls.model === 'cruise' ? cruiseShipModel({ length_m: L, beam_m: A.B || L * 0.13 }, lit)
    : merchantModel({ length_m: L, beam_m: A.B, tanker: A.type >= 80 && A.type <= 89 }, lit);
  return { group, L: cls.model === 'launch' ? clamp(L, 9, 40) : L };
}
// what she is, from her AIS (and her record, if we have one): { K, W, S, cls } — K one of the ferries (her
// ferries.json record), W one of the windjammers, S her record in data/ships.json, cls { model, what }. Fills in
// her length and beam from K or S while her own static data hasn't come.
export function identify(A) {
  const kn0 = knownFor(A.name, A.lon, A.lat), K = kn0?.F;   // one of the ferries: a ferry, her length known, before her static data comes
  // one of the windjammers, unless what she says she is rules it out (a lobster boat or tug of the same name)
  const W = kn0?.W && !(A.type >= 30 && A.type <= 35 || A.type >= 50 && A.type <= 59 || A.type >= 70 && A.type <= 89) ? kn0.W : null;
  if (K && !A.L) A.L = K.length_m || 46;
  const S = !K && !W ? shipFor(A.mmsi, A.name).S : null;   // one of the ships we have particulars for (data/ships.json, v1001)
  if (S) { if (!A.L) A.L = S.L; if (!A.B) A.B = S.B; }
  let cls = K ? { model: K.kind === 'launch' || A.L < 25 ? 'launch' : 'ferry', what: K.says || 'Ferry' }
    : W ? { model: 'sail', what: `${W.model === 'bowdoin' ? 'Schooner' : 'Windjammer'}, out of ${W.port}` } : S && !A.type ? { model: S.kind, what: S.what } : RESEARCH.test(A.name || '') || S?.kind === 'research' ? { model: 'research', what: S?.what || 'Research vessel' } : CUTTER.test(A.name || '') ? { model: 'cutter', what: 'Coast Guard cutter' } : CABLE.test(A.name || '') || S?.kind === 'cable' ? { model: 'cable', what: S?.what || 'Cable ship' } : (OSV.test(A.name || '') && !(A.L && A.L < 40)) || S?.kind === 'osv' ? { model: 'osv', what: S?.what || 'Offshore supply vessel' } : aisClass(A.type, A.L);
  if (cls.model === 'trawler' && scalloper(A, S)) cls = { model: 'scalloper', what: 'Scalloper' };
  // (v1177) pushing ahead or towing astern is a towing vessel's status: a tug, whatever else she does or doesn't say (the
  // Erin Elizabeth and the Alexandra, no type given, had been drawn as ships 89 and 138 m long)
  if ((A.status === 11 || A.status === 12) && !K && !W && ['ship', 'launch', 'power', 'cargo'].includes(cls.model)) cls = { model: 'tug', what: 'Tug' };
  if (!K && !W && (A.type >= 60 && A.type <= 69 || A.type >= 40 && A.type <= 49)) { const h = harborKind(A); if (h) cls = { ...cls, model: 'ferry', what: h.what, harbor: h }; }
  return { K, W, S, cls };
}
